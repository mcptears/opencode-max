// Command zai-collect harvests Z.ai device tokens automatically using a
// headless browser — the same method as the reference bridge's token-collector.
//
// It loads chat.z.ai in Chromium with a stealth fingerprint, performs
// human-like interaction (model select, type, send) to initialize the
// Aliyun device SDK (window.z_um), then calls getToken() in batches.
// Tokens are stored in the zai_device_tokens pool (SQLite) where the zai
// provider consumes them FIFO, one per captcha.
//
// Usage:
//
//	zai-collect [--tokens 850] [--batch 5] [--parallel 1] [--headed]
//	            [--block-trackers] [--unsafe]
//	zai-collect --count 20   # single batch of 20 (dashboard compat)
//
// The data dir is resolved the same way as the server (OM_DATA_DIR or ./data).
package main

import (
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mcptears/opencode-max/db"
	"github.com/mcptears/opencode-max/zaitokens"
	"github.com/mxschmitt/playwright-go"
)

// ---------- Configuration (same limits as the reference collector) ----------
const (
	maxTokens         = 1500
	unsafeMaxTokens   = 1500
	defaultTokens     = 850
	defaultBatch      = 5
	maxBatch          = 9
	unsafeMaxBatch    = 25
	sendWaitMs        = 12000
	maxRetries        = 3
	tokenTimeoutMs    = 90000
	zaiURL            = "https://chat.z.ai"
	maxParallel       = 3
	unsafeMaxParallel = 5

	modelSelectorButton = `button[id^="model-selector-"][id$="-button"]`
	stealthTimezone     = "America/New_York"
	stealthLocale       = "en-US"
)

// ---------- Flags ----------
var (
	unsafeFlag        = flag.Bool("unsafe", false, "increase batch limit to 25 and parallel limit to 5")
	tokensFlag        = flag.Int("tokens", 0, "tokens per batch (0 = default 850)")
	batchFlag         = flag.Int("batch", 0, "number of batches (0 = default 5)")
	countFlag         = flag.Int("count", 0, "single batch of N tokens (compat with dashboard; overrides --tokens/--batch)")
	headedFlag        = flag.Bool("headed", false, "show browser window for debugging")
	parallelFlag      = flag.Int("parallel", 0, "parallel workers (pages) on a single browser; 0 = 1")
	blockTrackersFlag = flag.Bool("block-trackers", false, "enable URL allowlist filter to block trackers (off by default)")
)

func init() {
	// GC tuning: lets the heap grow 3x before collecting, cutting GC pauses
	// in allocation-heavy collection runs.
	debug.SetGCPercent(200)
}

func main() {
	flag.Parse()

	maxTok := maxTokens
	maxB := maxBatch
	maxPar := maxParallel
	if *unsafeFlag {
		maxTok = unsafeMaxTokens
		maxB = unsafeMaxBatch
		maxPar = unsafeMaxParallel
		fmt.Println("⚠️  --unsafe mode enabled")
	}

	// Resolve batch plan. --count wins (single batch, dashboard compat).
	tokenCount := *tokensFlag
	batchCount := *batchFlag
	if *countFlag > 0 {
		tokenCount = *countFlag
		batchCount = 1
	} else {
		if tokenCount <= 0 {
			tokenCount = defaultTokens
		}
		if batchCount <= 0 {
			batchCount = defaultBatch
		}
	}
	if tokenCount > maxTok {
		fmt.Printf("⚠️  Capping tokens to max %d.\n", maxTok)
		tokenCount = maxTok
	}
	if batchCount > maxB {
		fmt.Printf("⚠️  Capping batches to max %d.\n", maxB)
		batchCount = maxB
	}
	parallelWorkers := *parallelFlag
	if parallelWorkers <= 0 {
		parallelWorkers = 1
	}
	if parallelWorkers > maxPar {
		fmt.Printf("⚠️  Capping parallel workers to max %d.\n", maxPar)
		parallelWorkers = maxPar
	}

	fmt.Printf("\n🎯 Plan: %d tokens × %d batches = %d total tokens", tokenCount, batchCount, tokenCount*batchCount)
	if parallelWorkers > 1 {
		fmt.Printf("  (parallel: %d workers)", parallelWorkers)
	}
	fmt.Println()

	if err := run(tokenCount, batchCount, parallelWorkers, *headedFlag); err != nil {
		log.Fatal(err)
	}
	fmt.Println("\n🎉 Collection finished successfully.")
}

// ---------- Browser proxy (egress env vars) ----------

func browserProxy() *playwright.Proxy {
	raw := os.Getenv("HTTPS_PROXY")
	if raw == "" {
		raw = os.Getenv("https_proxy")
	}
	if raw == "" {
		raw = os.Getenv("HTTP_PROXY")
	}
	if raw == "" {
		raw = os.Getenv("http_proxy")
	}
	if raw == "" {
		return nil
	}
	p := &playwright.Proxy{}
	if at := strings.LastIndex(raw, "@"); at > 0 {
		schemeEnd := strings.Index(raw, "://")
		cred := raw[schemeEnd+3 : at]
		if ci := strings.Index(cred, ":"); ci >= 0 {
			p.Username = playwright.String(cred[:ci])
			p.Password = playwright.String(cred[ci+1:])
		} else {
			p.Username = playwright.String(cred)
		}
		p.Server = raw[:schemeEnd+3] + raw[at+1:]
	} else {
		p.Server = raw
	}
	return p
}

// ---------- Human input synthesis ----------

var humanRand = rand.New(rand.NewSource(time.Now().UnixNano()))

func jitter(min, max float64) float64 {
	return min + humanRand.Float64()*(max-min)
}

func humanPause(msMin, msMax int) {
	time.Sleep(time.Duration(jitter(float64(msMin), float64(msMax))) * time.Millisecond)
}

// humanMouseTo sweeps the cursor from a random point toward (tx,ty) with
// smoothstep easing and per-step jitter — mimics a human pointer path.
func humanMouseTo(page playwright.Page, tx, ty float64) error {
	x := jitter(300, 1500)
	y := jitter(200, 800)
	steps := 12 + humanRand.Intn(10)
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		e := t * t * (3 - 2*t) // smoothstep: slow → fast → slow
		nx := x + (tx-x)*e + jitter(-6, 6)
		ny := y + (ty-y)*e + jitter(-6, 6)
		if err := page.Mouse().Move(nx, ny); err != nil {
			return err
		}
		time.Sleep(time.Duration(jitter(8, 22)) * time.Millisecond)
	}
	return page.Mouse().Move(tx, ty)
}

// humanClick moves along an eased path to a random point inside the element,
// dwells briefly, then presses and releases.
func humanClick(page playwright.Page, loc playwright.Locator) error {
	box, err := loc.BoundingBox()
	if err != nil {
		return err
	}
	if box == nil {
		return fmt.Errorf("element has no bounding box")
	}
	cx := box.X + box.Width*jitter(0.35, 0.65)
	cy := box.Y + box.Height*jitter(0.35, 0.65)
	if err := humanMouseTo(page, cx, cy); err != nil {
		return err
	}
	humanPause(60, 180)
	if err := page.Mouse().Down(); err != nil {
		return err
	}
	humanPause(45, 110)
	return page.Mouse().Up()
}

// ---------- Stealth fingerprint ----------
// Injected via AddInitScript — runs BEFORE any page script (including captcha
// SDKs) on every document and every frame. __VER__ is the Chromium major.

var stealthMajorOnce sync.Once
var stealthMajor = "131"

func stealthChromeMajor(browser playwright.Browser) string {
	stealthMajorOnce.Do(func() {
		v := browser.Version()
		if i := strings.IndexByte(v, '.'); i > 0 {
			stealthMajor = v[:i]
		}
		fmt.Printf("🥷 Stealth identity: Chrome/%s on Windows 10 (x64)\n", stealthMajor)
	})
	return stealthMajor
}

func stealthUserAgent(major string) string {
	return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Safari/537.36"
}

const stealthJSTemplate = `(function () {
    'use strict';
    var patched = [];
    function track(fn) { patched.push(fn); return fn; }
    var ua = navigator.userAgent || '';
    var isWin = ua.indexOf('Windows NT') !== -1;
    var isMac = ua.indexOf('Macintosh') !== -1;
    var platOS = isWin ? 'Windows' : (isMac ? 'macOS' : 'Linux');
    var platNav = isWin ? 'Win32' : (isMac ? 'MacIntel' : 'Linux x86_64');
    try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
            get: track(function webdriver() { return false; }), configurable: true,
        });
    } catch (e) {}
    try {
        Object.defineProperty(Navigator.prototype, 'languages', {
            get: track(function languages() { return ['en-US', 'en']; }), configurable: true,
        });
        Object.defineProperty(Navigator.prototype, 'language', {
            get: track(function language() { return 'en-US'; }), configurable: true,
        });
    } catch (e) {}
    try {
        Object.defineProperty(Navigator.prototype, 'platform', {
            get: track(function platform() { return platNav; }), configurable: true,
        });
    } catch (e) {}
    try {
        Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
            get: track(function hardwareConcurrency() { return 8; }), configurable: true,
        });
        if (!('deviceMemory' in navigator)) {
            Object.defineProperty(Navigator.prototype, 'deviceMemory', {
                get: track(function deviceMemory() { return 8; }), configurable: true,
            });
        }
    } catch (e) {}
    try {
        var names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
                     'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
        var file = 'internal-pdf-viewer';
        var desc = 'Portable Document Format';
        var mimeDefs = [
            { type: 'application/pdf', suffixes: 'pdf' },
            { type: 'text/pdf', suffixes: 'pdf' },
        ];
        var plugins = [];
        names.forEach(function (n) {
            var plugin = Object.create(Plugin.prototype);
            Object.defineProperties(plugin, {
                name: { value: n, enumerable: true },
                filename: { value: file, enumerable: true },
                description: { value: desc, enumerable: true },
                length: { value: mimeDefs.length, enumerable: true },
            });
            mimeDefs.forEach(function (m, i) {
                Object.defineProperty(plugin, i, {
                    value: { type: m.type, suffixes: m.suffixes,
                             description: desc, enabledPlugin: plugin },
                    enumerable: true,
                });
            });
            plugins.push(plugin);
        });
        var mimeTypes = [];
        mimeDefs.forEach(function (m) {
            mimeTypes.push({ type: m.type, suffixes: m.suffixes,
                             description: desc, enabledPlugin: plugins[0] });
        });
        Object.defineProperty(Navigator.prototype, 'plugins', {
            get: track(function plugins() { return plugins; }), configurable: true,
        });
        Object.defineProperty(Navigator.prototype, 'mimeTypes', {
            get: track(function mimeTypes() { return mimeTypes; }), configurable: true,
        });
    } catch (e) {}
    try {
        if (!window.chrome) { window.chrome = {}; }
        if (!window.chrome.runtime) {
            window.chrome.runtime = {
                OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install',
                    SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
                OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update',
                    PERIODIC: 'periodic' },
                PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips',
                    MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64',
                    X86_32: 'x86-32', X86_64: 'x86-64' },
                PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux',
                    MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                RequestUpdateCheckStatus: { NO_UPDATE: 'no_update',
                    THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
            };
        }
        if (!window.chrome.app) {
            window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled',
                INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run',
                    RUNNING: 'running' } };
        }
        if (!window.chrome.loadTimes) {
            window.chrome.loadTimes = track(function loadTimes() {
                var t = Date.now() / 1000;
                return { requestTime: t, startLoadTime: t, commitLoadTime: t,
                    finishDocumentLoadTime: t, finishLoadTime: t, firstPaintTime: t,
                    firstPaintAfterLoadTime: 0, navigationType: 'Other',
                    wasFetchedViaSpdy: false, wasNpnNegotiated: true,
                    npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
                    connectionInfo: 'h2' };
            });
        }
        if (!window.chrome.csi) {
            window.chrome.csi = track(function csi() {
                return { startE: Date.now(), onloadT: Date.now(), pageT: 10, tran: 15 };
            });
        }
    } catch (e) {}
    try {
        if (window.navigator.permissions && window.navigator.permissions.query) {
            var oq = window.navigator.permissions.query.bind(window.navigator.permissions);
            window.navigator.permissions.query = track(function query(p) {
                if (p && p.name === 'notifications') {
                    return Promise.resolve({ state: 'default', onchange: null });
                }
                return oq(p);
            });
        }
    } catch (e) {}
    try {
        var vendor = isWin ? 'Google Inc. (Intel)' : (isMac ? 'Google Inc. (Apple)' : 'Google Inc. (Intel)');
        var renderer = isWin
            ? 'ANGLE (Intel, Intel(R) UHD Graphics 630 (D3D11), D3D11)'
            : (isMac
                ? 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'
                : 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)');
        function patchGet(proto) {
            var orig = proto.getParameter;
            proto.getParameter = track(function getParameter(p) {
                if (p === 37445) { return vendor; }
                if (p === 37446) { return renderer; }
                return orig.apply(this, arguments);
            });
        }
        if (typeof WebGLRenderingContext !== 'undefined') { patchGet(WebGLRenderingContext.prototype); }
        if (typeof WebGL2RenderingContext !== 'undefined') { patchGet(WebGL2RenderingContext.prototype); }
    } catch (e) {}
    try {
        if (navigator.userAgentData) {
            var uad = {
                brands: [
                    { brand: 'Chromium', version: '__VER__' },
                    { brand: 'Google Chrome', version: '__VER__' },
                    { brand: 'Not_A Brand', version: '24' },
                ],
                mobile: false,
                platform: platOS,
                getHighEntropyValues: track(function getHighEntropyValues(hints) {
                    return Promise.resolve({
                        architecture: 'x86', bitness: '64', model: '', platform: platOS,
                        platformVersion: isWin ? '15.0.0' : (isMac ? '14.1.0' : '6.5.0'),
                        uaFullVersion: '__VER__.0.0.0',
                        fullVersionList: [
                            { brand: 'Chromium', version: '__VER__.0.0.0' },
                            { brand: 'Google Chrome', version: '__VER__.0.0.0' },
                            { brand: 'Not_A Brand', version: '24.0.0.0' },
                        ],
                    });
                }),
            };
            Object.defineProperty(Navigator.prototype, 'userAgentData', {
                get: track(function userAgentData() { return uad; }), configurable: true,
            });
        }
    } catch (e) {}
    try {
        Object.defineProperty(window, 'outerWidth', {
            get: track(function outerWidth() { return 1920; }), configurable: true,
        });
        Object.defineProperty(window, 'outerHeight', {
            get: track(function outerHeight() { return 1160; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'width', {
            get: track(function width() { return 2560; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'height', {
            get: track(function height() { return 1440; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'availWidth', {
            get: track(function availWidth() { return 2560; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'availHeight', {
            get: track(function availHeight() { return 1400; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'colorDepth', {
            get: track(function colorDepth() { return 24; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'pixelDepth', {
            get: track(function pixelDepth() { return 24; }), configurable: true,
        });
    } catch (e) {}
    try {
        var d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
        if (d && d.get) {
            var og = d.get;
            Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                get: track(function contentWindow() {
                    var w = og.call(this);
                    try { if (w && !w.chrome && window.chrome) { w.chrome = window.chrome; } } catch (e) {}
                    return w;
                }), configurable: true,
            });
        }
    } catch (e) {}
    try {
        if (typeof Notification !== 'undefined') {
            Object.defineProperty(Notification, 'permission', {
                get: track(function permission() { return 'default'; }), configurable: true,
            });
        }
    } catch (e) {}
    try {
        var origToString = Function.prototype.toString;
        var toStringProxy = new Proxy(origToString, {
            apply: function (target, thisArg, args) {
                if (thisArg && patched.indexOf(thisArg) !== -1) {
                    return 'function ' + (thisArg.name || '') + '() { [native code] }';
                }
                return Reflect.apply(target, thisArg, args);
            },
        });
        patched.push(toStringProxy);
        Function.prototype.toString = toStringProxy;
    } catch (e) {}
})();`

// ---------- Network allowlist (surgical URL filter) ----------

var (
	reZCDN      = regexp.MustCompile(`^https://z-cdn\.chatglm\.cn/z-ai/frontend/prod-fe-[^/]+/.*$`)
	reCloudAuth = regexp.MustCompile(`^https://cloudauth-device-dualstack\.[^/]+\.aliyuncs\.com/.*$`)
	reFeiLin    = regexp.MustCompile(`^https://g\.alicdn\.com/captcha-frontend/FeiLin/.*$`)
)

func urlAllowed(u string) bool {
	switch {
	case strings.HasPrefix(u, "https://chat.z.ai/"), strings.HasPrefix(u, "wss://chat.z.ai/"):
		return true
	case strings.HasPrefix(u, "https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-"):
		return reZCDN.MatchString(u)
	case u == "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js":
		return true
	case strings.HasPrefix(u, "https://cloudauth-device-dualstack."):
		return reCloudAuth.MatchString(u)
	case strings.HasPrefix(u, "https://g.alicdn.com/captcha-frontend/FeiLin/"):
		return reFeiLin.MatchString(u)
	}
	return false
}

// ---------- Worker page ----------

// newWorkerPage creates a stealth browser context + page. Each worker keeps
// ONE page open for all its batches; every batch force-reloads by re-navigating.
func newWorkerPage(browser playwright.Browser) (playwright.BrowserContext, playwright.Page, error) {
	major := stealthChromeMajor(browser)
	ua := stealthUserAgent(major)
	stealthJS := strings.ReplaceAll(stealthJSTemplate, "__VER__", major)

	ctx, err := browser.NewContext(playwright.BrowserNewContextOptions{
		UserAgent:         playwright.String(ua),
		Locale:            playwright.String(stealthLocale),
		TimezoneId:        playwright.String(stealthTimezone),
		ColorScheme:       playwright.ColorSchemeLight,
		DeviceScaleFactor: playwright.Float(1),
		Viewport:          &playwright.Size{Width: 1920, Height: 1080},
		Screen:            &playwright.Size{Width: 1920, Height: 1440},
		ExtraHttpHeaders:  map[string]string{"Accept-Language": "en-US,en;q=0.9"},
	})
	if err != nil {
		return nil, nil, err
	}
	page, err := ctx.NewPage()
	if err != nil {
		_ = ctx.Close()
		return nil, nil, err
	}
	if err := page.AddInitScript(playwright.Script{Content: playwright.String(stealthJS)}); err != nil {
		_ = ctx.Close()
		return nil, nil, fmt.Errorf("stealth init script: %w", err)
	}
	if *blockTrackersFlag {
		if err := page.Route("**/*", func(route playwright.Route) {
			if urlAllowed(route.Request().URL()) {
				route.Continue()
			} else {
				route.Abort()
			}
		}); err != nil {
			_ = ctx.Close()
			return nil, nil, fmt.Errorf("route setup: %w", err)
		}
	}
	return ctx, page, nil
}

// ---------- Collect tokens on a single page ----------

func collectTokensOnPage(page playwright.Page, total int) ([]string, error) {
	// The page is reused across batches; force-reload by re-navigating.
	if _, err := page.Goto(zaiURL, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(60000),
	}); err != nil {
		return nil, fmt.Errorf("goto: %w", err)
	}

	// Wait for both elements concurrently.
	var err1, err2 error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		err1 = page.Locator(modelSelectorButton).First().WaitFor(
			playwright.LocatorWaitForOptions{Timeout: playwright.Float(15000)},
		)
	}()
	go func() {
		defer wg.Done()
		err2 = page.Locator("#chat-input").WaitFor(
			playwright.LocatorWaitForOptions{Timeout: playwright.Float(15000)},
		)
	}()
	wg.Wait()
	if err1 != nil {
		return nil, fmt.Errorf("model button not found: %w", err1)
	}
	if err2 != nil {
		return nil, fmt.Errorf("textarea not found: %w", err2)
	}
	fmt.Println("✅ Model button & textarea found")

	// Select the x-preview-l model (button id encodes the selected model).
	modelBtn := page.Locator(modelSelectorButton).First()
	modelBtnID, _ := modelBtn.GetAttribute("id")
	if strings.Contains(modelBtnID, "x-preview-l") {
		fmt.Println("✅ x-preview-l already selected — skipping model switch")
	} else {
		if err := humanClick(page, modelBtn); err != nil {
			return nil, fmt.Errorf("human click on model button: %w", err)
		}
		humanPause(150, 400)
		menu := page.Locator("[data-dropdown-menu-content][data-state='open']")
		if err := menu.WaitFor(
			playwright.LocatorWaitForOptions{Timeout: playwright.Float(10000)},
		); err != nil {
			return nil, fmt.Errorf("model dropdown did not open: %w", err)
		}
		modelOpt := page.Locator(`button[data-value="x-preview-l"]`)
		if err := modelOpt.WaitFor(
			playwright.LocatorWaitForOptions{Timeout: playwright.Float(5000)},
		); err != nil {
			return nil, fmt.Errorf("x-preview-l option not found: %w", err)
		}
		list := menu.Locator("div.overflow-y-auto")
		listBox, err := list.BoundingBox()
		if err != nil || listBox == nil {
			return nil, fmt.Errorf("model list not measurable: %v", err)
		}
		_ = humanMouseTo(page, listBox.X+listBox.Width*jitter(0.3, 0.7), listBox.Y+listBox.Height*0.5)
		humanPause(100, 250)
		visible := func() bool {
			gb, err := modelOpt.BoundingBox()
			return err == nil && gb != nil &&
				gb.Y >= listBox.Y+2 && gb.Y+gb.Height <= listBox.Y+listBox.Height-2
		}
		for i := 0; i < 8 && !visible(); i++ {
			if err := page.Mouse().Wheel(0, jitter(90, 160)); err != nil {
				return nil, fmt.Errorf("wheel scroll: %w", err)
			}
			humanPause(90, 220)
		}
		if !visible() {
			if err := modelOpt.ScrollIntoViewIfNeeded(
				playwright.LocatorScrollIntoViewIfNeededOptions{Timeout: playwright.Float(3000)},
			); err != nil {
				return nil, fmt.Errorf("scroll x-preview-l into view: %w", err)
			}
			humanPause(100, 250)
		}
		if err := humanClick(page, modelOpt); err != nil {
			return nil, fmt.Errorf("human click on x-preview-l: %w", err)
		}
		fmt.Println("✅ Model switched to x-preview-l")
		_ = menu.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateHidden,
			Timeout: playwright.Float(3000),
		})
		humanPause(200, 500)
	}

	textarea := page.Locator("#chat-input")

	// Behavioral warm-up: nobody lands on a page and instantly acts.
	fmt.Println("🧍 Human warm-up: cursor drift + micro-scroll...")
	_ = humanMouseTo(page, jitter(500, 1300), jitter(250, 650))
	humanPause(300, 800)
	_ = page.Mouse().Wheel(0, jitter(120, 320))
	humanPause(180, 450)
	_ = page.Mouse().Wheel(0, -jitter(60, 180))
	humanPause(250, 600)

	// Click into the textarea like a person, then type character by
	// character with irregular inter-key delays.
	if err := humanClick(page, textarea); err != nil {
		return nil, fmt.Errorf("human click on textarea: %w", err)
	}
	humanPause(120, 300)
	for _, r := range "__" {
		if err := page.Keyboard().Type(string(r)); err != nil {
			return nil, fmt.Errorf("type char: %w", err)
		}
		humanPause(50, 140)
	}
	fmt.Println(`✅ Typed "__" with human-like cadence`)

	sendBtn := page.Locator("#send-message-button")
	if err := sendBtn.WaitFor(
		playwright.LocatorWaitForOptions{Timeout: playwright.Float(5000)},
	); err != nil {
		return nil, fmt.Errorf("send button not found: %w", err)
	}
	humanPause(200, 500)
	if err := humanClick(page, sendBtn); err != nil {
		return nil, fmt.Errorf("human click on send: %w", err)
	}
	fmt.Println("✅ Send clicked (eased mouse path + button dwell)")

	fmt.Printf("⏳ Waiting %dms for token endpoint to initialize...\n", sendWaitMs)
	time.Sleep(sendWaitMs * time.Millisecond)

	// Fast token collection with timeout — one JS loop, not N round trips.
	fmt.Printf("🚀 Collecting %d tokens...\n", total)
	t0 := time.Now()
	type evalResult struct {
		val interface{}
		err error
	}
	resultCh := make(chan evalResult, 1)
	go func() {
		val, err := page.Evaluate(`async (args) => {
            const total = args.total;
            const out = new Array(total);
            for (let i = 0; i < total; i++) {
                const tok = window.z_um.getToken();
                out[i] = (tok && typeof tok.then === 'function') ? await tok : tok;
                if (i % 50 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            return out;
        }`, map[string]interface{}{"total": total})
		resultCh <- evalResult{val, err}
	}()
	select {
	case res := <-resultCh:
		if res.err != nil {
			return nil, fmt.Errorf("evaluate: %w", res.err)
		}
		arr, ok := res.val.([]interface{})
		if !ok {
			return nil, fmt.Errorf("unexpected evaluate result type: %T", res.val)
		}
		tokens := make([]string, 0, len(arr))
		for _, v := range arr {
			if s, ok := v.(string); ok {
				tokens = append(tokens, s)
			} else if v != nil {
				tokens = append(tokens, fmt.Sprintf("%v", v))
			}
		}
		fmt.Printf("✅ Collected %d tokens in %.2fs\n", len(tokens), time.Since(t0).Seconds())
		return tokens, nil
	case <-time.After(tokenTimeoutMs * time.Millisecond):
		return nil, fmt.Errorf("⏱️ token collection timed out after %ds", tokenTimeoutMs/1000)
	}
}

// ---------- Run one batch with retries ----------

func runBatch(page playwright.Page, total, batchNum int) ([]string, error) {
	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("\n🔄 [Batch %d] Attempt %d of %d\n", batchNum, attempt, maxRetries)
		tokens, err := collectTokensOnPage(page, total)
		if err != nil {
			lastErr = err
			fmt.Printf("❌ Attempt %d failed: %v\n", attempt, err)
			if attempt == maxRetries {
				fmt.Fprintln(os.Stderr, "🚫 All retries exhausted.")
				break
			}
			fmt.Println("♻️  Retrying with a forced page reload...")
			continue
		}
		return tokens, nil
	}
	return nil, fmt.Errorf("batch %d failed: %w", batchNum, lastErr)
}

// ---------- Run ----------

func run(tokenCount, batchCount, workers int, headed bool) error {
	database, err := db.Open(db.DataDir())
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer database.Close()
	store := zaitokens.NewStore(database)

	pw, err := playwright.Run()
	if err != nil {
		return fmt.Errorf("playwright: %w (run `playwright install chromium` first)", err)
	}
	defer pw.Stop()

	browser, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(!headed),
		Args:     []string{"--disable-blink-features=AutomationControlled", "--no-sandbox"},
		Proxy:    browserProxy(),
	})
	if err != nil {
		return fmt.Errorf("launch chromium: %w", err)
	}
	defer browser.Close()

	var totalCol atomic.Int64
	var aborted atomic.Bool
	var once sync.Once
	var firstErr error

	batchCh := make(chan int, batchCount)
	for b := 1; b <= batchCount; b++ {
		batchCh <- b
	}
	close(batchCh)

	var wg sync.WaitGroup
	for w := 1; w <= workers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			ctx, page, perr := newWorkerPage(browser)
			if perr != nil {
				once.Do(func() {
					firstErr = fmt.Errorf("worker %d page: %w", workerID, perr)
					aborted.Store(true)
				})
				return
			}
			defer ctx.Close()
			for batchNum := range batchCh {
				if aborted.Load() {
					return
				}
				fmt.Printf("\n👷 [Worker %d] starting batch %d\n", workerID, batchNum)
				tokens, err := runBatch(page, tokenCount, batchNum)
				if err != nil {
					once.Do(func() {
						firstErr = err
						aborted.Store(true)
					})
					return
				}
				added, derr := store.Add(tokens)
				if derr != nil {
					once.Do(func() {
						firstErr = fmt.Errorf("store tokens: %w", derr)
						aborted.Store(true)
					})
					return
				}
				totalCol.Add(int64(added))
				fmt.Printf("📦 Batch %d stored: %d new (pool total %d)\n", batchNum, added, store.Count())
			}
		}(w)
	}
	wg.Wait()

	if firstErr != nil {
		return firstErr
	}
	fmt.Printf("\nDone: %d new tokens harvested (pool total %d).\n", totalCol.Load(), store.Count())
	_ = os.Stdout.Sync()
	return nil
}

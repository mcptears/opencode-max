// Command zai-collect harvests Z.ai device tokens automatically using a
// headless browser — the same method as the reference bridge's token-collector.
//
// It loads chat.z.ai in Chromium, waits for the Aliyun device SDK
// (window.z_um), and calls getToken() N times. Tokens are stored in the
// zai_device_tokens pool (SQLite) where the zai provider consumes them
// FIFO, one per captcha.
//
// Usage:
//
//	zai-collect [--count 20] [--headed]
//
// The data dir is resolved the same way as the server (OM_DATA_DIR or ./data).
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/mcptears/opencode-max/db"
	"github.com/mcptears/opencode-max/zaitokens"
	"github.com/mxschmitt/playwright-go"
)

func main() {
	count := flag.Int("count", 20, "device tokens to harvest")
	headed := flag.Bool("headed", false, "show the browser window (debugging)")
	flag.Parse()

	if err := run(*count, *headed); err != nil {
		log.Fatal(err)
	}
}

// browserProxy picks up the standard proxy env vars so the harvester works
// behind an egress proxy (same behavior as curl/Go http clients).
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
	// Split off embedded credentials: http://user:pass@host:port
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

func run(count int, headed bool) error {
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
		Args: []string{
			"--disable-blink-features=AutomationControlled",
			"--no-sandbox",
		},
		Proxy: browserProxy(),
	})
	if err != nil {
		return fmt.Errorf("launch chromium: %w", err)
	}
	defer browser.Close()

	ctx, err := browser.NewContext(playwright.BrowserNewContextOptions{
		UserAgent:   playwright.String("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"),
		Locale:      playwright.String("en-US"),
		TimezoneId:  playwright.String("Europe/Paris"),
		Viewport:    &playwright.Size{Width: 1920, Height: 1080},
		Screen:      &playwright.Size{Width: 1920, Height: 1080},
		DeviceScaleFactor: playwright.Float(1),
	})
	if err != nil {
		return fmt.Errorf("new context: %w", err)
	}

	page, err := ctx.NewPage()
	if err != nil {
		return fmt.Errorf("new page: %w", err)
	}

	fmt.Println("Loading chat.z.ai ...")
	if _, err := page.Goto("https://chat.z.ai", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(60000),
	}); err != nil {
		return fmt.Errorf("goto: %w", err)
	}

	// Wait for the Aliyun device SDK.
	fmt.Println("Waiting for device SDK (window.z_um) ...")
	if _, err := page.WaitForFunction(`() => typeof window.z_um !== 'undefined' && typeof window.z_um.getToken === 'function'`,
		nil, playwright.PageWaitForFunctionOptions{Timeout: playwright.Float(30000)}); err != nil {
		return fmt.Errorf("device SDK not found: %w", err)
	}
	// Let the SDK settle.
	time.Sleep(3 * time.Second)

	fmt.Printf("Harvesting %d device tokens ...\n", count)
	tokens := make([]string, 0, count)
	for i := 0; i < count; i++ {
		val, err := page.Evaluate(`async () => {
			const t = window.z_um.getToken();
			return (t && typeof t.then === 'function') ? await t : t;
		}`)
		if err != nil {
			fmt.Printf("  [%d] error: %v\n", i+1, err)
			continue
		}
		tok, _ := val.(string)
		if tok == "" {
			fmt.Printf("  [%d] empty token\n", i+1)
			continue
		}
		tokens = append(tokens, tok)
		fmt.Printf("  [%d] got %d chars\n", i+1, len(tok))
		// Small pause between harvests so each fingerprint settles.
		time.Sleep(500 * time.Millisecond)
	}

	added, err := store.Add(tokens)
	if err != nil {
		return fmt.Errorf("store tokens: %w", err)
	}
	fmt.Printf("Done: %d new tokens in pool (total %d).\n", added, store.Count())
	_ = os.Stdout.Sync()
	return nil
}

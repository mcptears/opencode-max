// Command qwen-login performs an automated Qwen sign-in using a headless
// browser — the same harvest approach as the reference qwen2api bridge.
//
// It loads chat.qwen.ai/auth, fills the email + password, submits the form,
// waits for the session token to appear in localStorage, and prints the
// token (plus cookies) as JSON. The server calls this automatically when the
// user signs in from the dashboard — no DevTools needed.
//
// Usage:
//
//	qwen-login --email user@example.com --password secret
//
// Password can also come from QWEN_PASSWORD env (avoids shell history).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/mxschmitt/playwright-go"
)

type result struct {
	OK       bool   `json:"ok"`
	Token    string `json:"token,omitempty"`
	Cookies  string `json:"cookies,omitempty"`
	Error    string `json:"error,omitempty"`
	NeedCode bool   `json:"needCode,omitempty"`
}

func main() {
	email := flag.String("email", "", "Qwen account email")
	password := flag.String("password", "", "Qwen account password (or QWEN_PASSWORD env)")
	headed := flag.Bool("headed", false, "show the browser window (debugging)")
	flag.Parse()
	if *password == "" {
		*password = os.Getenv("QWEN_PASSWORD")
	}
	if os.Getenv("QWEN_HEADED") == "1" {
		*headed = true
	}
	res := login(*email, *password, *headed)
	out, _ := json.Marshal(res)
	fmt.Println(string(out))
	if !res.OK {
		os.Exit(1)
	}
}

func login(email, password string, headed bool) result {
	if !strings.Contains(email, "@") || password == "" {
		return result{Error: "email and password are required"}
	}
	pw, err := playwright.Run()
	if err != nil {
		return result{Error: fmt.Sprintf("playwright: %v (run `playwright install chromium` first)", err)}
	}
	defer pw.Stop()

	browser, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(!headed),
		Args:     []string{"--disable-blink-features=AutomationControlled", "--no-sandbox"},
		Proxy:    browserProxy(),
	})
	if err != nil {
		return result{Error: fmt.Sprintf("launch chromium: %v", err)}
	}
	defer browser.Close()

	ctx, err := browser.NewContext(playwright.BrowserNewContextOptions{
		UserAgent:   playwright.String("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"),
		Locale:      playwright.String("en-US"),
		Viewport:    &playwright.Size{Width: 1920, Height: 1080},
	})
	if err != nil {
		return result{Error: fmt.Sprintf("new context: %v", err)}
	}
	page, err := ctx.NewPage()
	if err != nil {
		return result{Error: fmt.Sprintf("new page: %v", err)}
	}

	if _, err := page.Goto("https://chat.qwen.ai/auth", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(30000),
	}); err != nil {
		return result{Error: fmt.Sprintf("load login page: %v", err)}
	}
	time.Sleep(2 * time.Second)

	// Fill email.
	if !fillFirst(page, []string{`input[placeholder*="Email" i]`, `input[type="email"]`}, email) {
		return result{Error: "email field not found"}
	}
	// The auth page defaults to verification-code mode — click
	// "Log in with a password" to switch to password mode.
	clickFirst(page, []string{
		`text="Log in with a password"`, `a:has-text("Log in with a password")`,
		`button:has-text("Log in with a password")`,
	})
	time.Sleep(2 * time.Second)
	// Password may be on the same form or behind a Continue step.
	if !passwordVisible(page) {
		// Multi-step login: submit the email first, then the password field appears.
		clickFirst(page, []string{
			`button:has-text("Continue")`, `button:has-text("Next")`, `button[type="submit"]`,
		})
		time.Sleep(2 * time.Second)
	}
	if !fillFirst(page, []string{`input[type="password"]`, `input[placeholder*="Password" i]`}, password) {
		return result{Error: "password field not found"}
	}
	// Submit.
	clicked := clickFirst(page, []string{
		`button:has-text("Log in")`, `button[type="submit"]`, `button:has-text("Continue")`,
	})
	if !clicked {
		_ = page.Press(`input[type="password"]`, "Enter")
	}

	// Wait for the session token (up to 60s — may include captcha/2FA).
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if tok := localStorageToken(page); tok != "" {
			return result{OK: true, Token: tok, Cookies: cookieString(page)}
		}
		// Detect a verification-code challenge.
		if codeChallengeVisible(page) {
			return result{NeedCode: true, Error: "verification code required — complete it in the browser, then retry"}
		}
		time.Sleep(time.Second)
	}
	return result{Error: "login timed out — token never appeared (check credentials or complete the captcha)"}
}

func fillFirst(page playwright.Page, selectors []string, value string) bool {
	for _, sel := range selectors {
		if _, err := page.WaitForSelector(sel, playwright.PageWaitForSelectorOptions{Timeout: playwright.Float(8000)}); err != nil {
			continue
		}
		if err := page.Fill(sel, value, playwright.PageFillOptions{Timeout: playwright.Float(5000)}); err == nil {
			return true
		}
	}
	return false
}

func clickFirst(page playwright.Page, selectors []string) bool {
	for _, sel := range selectors {
		if err := page.Click(sel, playwright.PageClickOptions{Timeout: playwright.Float(5000)}); err == nil {
			return true
		}
	}
	return false
}

func localStorageToken(page playwright.Page) string {
	raw, err := page.Evaluate(`() => { try { return localStorage.getItem('token') || ''; } catch(e) { return ''; } }`)
	if err != nil {
		return ""
	}
	tok, _ := raw.(string)
	return strings.TrimSpace(strings.Trim(tok, `"`))
}

func passwordVisible(page playwright.Page) bool {
	v, _ := page.Evaluate(`() => {
		const el = document.querySelector('input[type="password"]');
		return !!(el && el.offsetParent !== null);
	}`)
	b, _ := v.(bool)
	return b
}

func codeChallengeVisible(page playwright.Page) bool {
	v, _ := page.Evaluate(`() => {
		const t = document.body ? document.body.innerText : '';
		return /verification code|enter code|verify.*email/i.test(t);
	}`)
	b, _ := v.(bool)
	return b
}

func cookieString(page playwright.Page) string {
	cookies, err := page.Context().Cookies()
	if err != nil {
		return ""
	}
	var parts []string
	for _, c := range cookies {
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

// browserProxy picks up the standard proxy env vars.
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
		se := strings.Index(raw, "://")
		cred := raw[se+3 : at]
		if ci := strings.Index(cred, ":"); ci >= 0 {
			p.Username = playwright.String(cred[:ci])
			p.Password = playwright.String(cred[ci+1:])
		}
		p.Server = raw[:se+3] + raw[at+1:]
	} else {
		p.Server = raw
	}
	return p
}

var _ = log.Println

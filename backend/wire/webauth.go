package wire

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/mcptears/opencode-max/api"
	"github.com/mcptears/opencode-max/providers/deepseek"
	"github.com/mcptears/opencode-max/providers/qwen"
	"github.com/mcptears/opencode-max/providers/zai"
)

// findHelperBinary locates a helper binary (qwen-login, zai-collect) next to
// the server binary, else on PATH.
func findHelperBinary(name string) string {
	if exe, err := os.Executable(); err == nil {
		cand := filepath.Join(filepath.Dir(exe), name)
		if _, err := os.Stat(cand); err == nil {
			return cand
		}
		if _, err := os.Stat(cand + ".exe"); err == nil {
			return cand + ".exe"
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return ""
}

// ---------------------------------------------------------------------------
// WebAuth: native web-provider credential flows -> api.WebAuth
// ---------------------------------------------------------------------------

type WebAuth struct {
	HTTP *http.Client
}

func (w *WebAuth) ValidateQwen(ctx context.Context, baseURL, credential, cookies string) api.ValidationResult {
	c := qwen.NewClient(baseURL)
	if err := c.Validate(ctx, credential, cookies); err != nil {
		return api.ValidationResult{Error: err.Error()}
	}
	return api.ValidationResult{OK: true}
}

func (w *WebAuth) QwenSignIn(ctx context.Context, baseURL, email, passwordHash string) api.SignInResult {
	// The TS implementation signs in via Qwen's auth API; the Go qwen client
	// does not yet implement password login. Return a clear error.
	return api.SignInResult{Error: "qwen password sign-in not implemented in Go rewrite — use paste-token"}
}

// QwenBrowserSignIn runs the qwen-login helper (headless Chromium) to sign in
// with the raw password and harvest the session token from localStorage.
func (w *WebAuth) QwenBrowserSignIn(ctx context.Context, email, password string) api.SignInResult {
	bin := findHelperBinary("qwen-login")
	if bin == "" {
		return api.SignInResult{Error: "qwen-login helper not found — build it: go build -o qwen-login ./cmd/qwen-login"}
	}
	type loginOut struct {
		OK       bool   `json:"ok"`
		Token    string `json:"token"`
		Cookies  string `json:"cookies"`
		Error    string `json:"error"`
		NeedCode bool   `json:"needCode"`
	}
	cmdCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, bin, "--email", email, "--password", password)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	_ = cmd.Run()
	var out loginOut
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = "qwen-login produced no output"
		}
		return api.SignInResult{Error: msg}
	}
	if !out.OK {
		return api.SignInResult{Error: out.Error, NeedCode: out.NeedCode}
	}
	return api.SignInResult{OK: true, Credential: out.Token, Cookies: out.Cookies}
}

func (w *WebAuth) ValidateDeepSeek(ctx context.Context, baseURL, credential, cookies string) api.ValidationResult {
	c := deepseek.NewClient(baseURL, credential, cookies, w.HTTP)
	if err := c.ValidateCredential(ctx); err != nil {
		return api.ValidationResult{Error: err.Error()}
	}
	return api.ValidationResult{OK: true}
}

func (w *WebAuth) DeepSeekSignIn(ctx context.Context, baseURL, email, passwordHash, verificationCode string) api.SignInResult {
	res, err := deepseek.SignIn(ctx, w.HTTP, baseURL, email, passwordHash, verificationCode)
	if err != nil {
		return api.SignInResult{Error: err.Error()}
	}
	if res.NeedCode {
		return api.SignInResult{NeedCode: true, Error: res.Message}
	}
	if !res.OK {
		return api.SignInResult{Error: res.Err}
	}
	return api.SignInResult{OK: true, Credential: res.Credential}
}

func (w *WebAuth) ResendDeepSeekCode(ctx context.Context, baseURL, email string) api.ValidationResult {
	// The deepseek package exposes sign-in with empty code to trigger resend;
	// keep it simple and report unsupported if the flow needs more.
	return api.ValidationResult{Error: "resend not implemented in Go rewrite"}
}

func (w *WebAuth) ValidateZai(ctx context.Context, baseURL, credential string) api.ValidationResult {
	c := zai.NewClient(baseURL, credential, w.HTTP)
	if _, err := c.ValidateCredential(ctx); err != nil {
		return api.ValidationResult{Error: err.Error()}
	}
	return api.ValidationResult{OK: true}
}

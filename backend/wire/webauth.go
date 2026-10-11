package wire

import (
	"context"
	"net/http"

	"github.com/mcptears/opencode-max/api"
	"github.com/mcptears/opencode-max/providers/deepseek"
	"github.com/mcptears/opencode-max/providers/qwen"
	"github.com/mcptears/opencode-max/providers/zai"
)

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

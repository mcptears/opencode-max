// Package deepseek implements the DeepSeek web-chat protocol
// (chat.deepseek.com private web API, reverse-engineered).
//
// Protocol:
//  1. Auth: POST /api/v0/users/login -> user token (Bearer).
//  2. POST /api/v0/chat_session/create -> disposable session id.
//  3. POST /api/v0/chat/create_pow_challenge -> DeepSeekHashV1 challenge.
//  4. Solve DeepSeekHashV1 locally (pure-Go Keccak below, no WASM/cgo).
//  5. POST /api/v0/chat/completion with x-ds-pow-response header.
//     Response is a JSON-patch SSE stream (not OpenAI SSE).
//  6. POST /api/v0/chat_session/delete (best-effort cleanup).
//
// DeepSeekHashV1 = Keccak-f[1600] with SHA-3 padding 0x06 but only rounds
// 1..23 (round zero skipped). It is neither SHA3-256 nor Keccak-256.
//
// Caveat: private, undocumented endpoints — any upstream change can break this.
package deepseek

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/bits"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Models is the full list of DeepSeek web models. DeepSeek exposes exactly
// one model; DeepThink and Web Search are toggles, not models.
var Models = []string{"deepseek-chat"}

// DefaultBaseURL is the DeepSeek web frontend origin.
const DefaultBaseURL = "https://chat.deepseek.com"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// WebError is a DeepSeek protocol error carrying an HTTP-style status so
// callers can map it to cooldown/invalid-credential handling.
type WebError struct {
	Msg    string
	Status int
}

func (e *WebError) Error() string { return e.Msg }

func webErrorf(status int, format string, args ...any) *WebError {
	return &WebError{Msg: fmt.Sprintf(format, args...), Status: status}
}

// ---------------------------------------------------------------------------
// DeepSeekHashV1 — Keccak-f[1600], rounds 1..23 only, rate 136, pad 0x06.
// ---------------------------------------------------------------------------

var dsRoundConstants = [24]uint64{
	0x0000000000000001, 0x0000000000008082, 0x800000000000808a,
	0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
	0x8000000080008081, 0x8000000000008009, 0x000000000000008a,
	0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
	0x000000008000808b, 0x800000000000008b, 0x8000000000008089,
	0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
	0x000000000000800a, 0x800000008000000a, 0x8000000080008081,
	0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
}

var dsRotationOffsets = [25]int{
	0, 1, 62, 28, 27,
	36, 44, 6, 55, 20,
	3, 10, 43, 25, 39,
	41, 45, 15, 21, 8,
	18, 2, 61, 56, 14,
}

const dsRate = 136

// keccakF1600DS runs Keccak-f[1600] over the 25-lane state, skipping round 0
// (DeepSeek's solver starts at round constant 1).
func keccakF1600DS(s *[25]uint64) {
	var c [5]uint64
	var b [25]uint64
	for r := 1; r < 24; r++ {
		// Theta
		for x := 0; x < 5; x++ {
			c[x] = s[x] ^ s[x+5] ^ s[x+10] ^ s[x+15] ^ s[x+20]
		}
		for x := 0; x < 5; x++ {
			d := c[(x+4)%5] ^ bits.RotateLeft64(c[(x+1)%5], 1)
			for y := 0; y < 5; y++ {
				s[x+5*y] ^= d
			}
		}
		// Rho + Pi
		for x := 0; x < 5; x++ {
			for y := 0; y < 5; y++ {
				src := x + 5*y
				dst := y + 5*((2*x+3*y)%5)
				b[dst] = bits.RotateLeft64(s[src], dsRotationOffsets[src])
			}
		}
		// Chi
		for y := 0; y < 5; y++ {
			for x := 0; x < 5; x++ {
				i := x + 5*y
				s[i] = b[i] ^ (^b[(x+1)%5+5*y] & b[(x+2)%5+5*y])
			}
		}
		// Iota
		s[0] ^= dsRoundConstants[r]
	}
}

// xorInto XORs bytes into the state at the given byte offset (little-endian lanes).
func xorInto(s *[25]uint64, data []byte, offset int) {
	for i, v := range data {
		pos := offset + i
		s[pos/8] ^= uint64(v) << (8 * (pos % 8))
	}
}

// DeepSeekHashV1 returns the 32-byte DeepSeekHashV1 digest of message.
func DeepSeekHashV1(message []byte) [32]byte {
	var s [25]uint64
	offset := 0
	for offset+dsRate <= len(message) {
		xorInto(&s, message[offset:offset+dsRate], offset)
		keccakF1600DS(&s)
		offset += dsRate
	}
	var block [dsRate]byte
	copy(block[:], message[offset:])
	block[len(message)-offset] ^= 0x06
	block[dsRate-1] ^= 0x80
	xorInto(&s, block[:], 0)
	keccakF1600DS(&s)
	var out [32]byte
	for i := 0; i < 32; i++ {
		out[i] = byte(s[i/8] >> (8 * (i % 8)))
	}
	return out
}

// Challenge is a DeepSeek PoW challenge from /api/v0/chat/create_pow_challenge.
type Challenge struct {
	Algorithm  string `json:"algorithm"`
	Challenge  string `json:"challenge"`
	Salt       string `json:"salt"`
	Difficulty int64  `json:"difficulty"`
	ExpireAt   int64  `json:"expire_at"`
	Signature  string `json:"signature"`
	TargetPath string `json:"target_path"`
}

// SolvePoW finds nonce in [0, difficulty) with
// DeepSeekHashV1("{salt}_{expire_at}_{nonce}") == challenge.
// It honors ctx cancellation so a hung solve can be aborted.
func SolvePoW(ctx context.Context, ch Challenge) (int64, error) {
	if ch.Algorithm != "DeepSeekHashV1" {
		return 0, webErrorf(502, "unsupported DeepSeek PoW algorithm %q", ch.Algorithm)
	}
	if ch.Difficulty <= 0 {
		return 0, webErrorf(502, "invalid DeepSeek PoW difficulty")
	}
	want := strings.ToLower(ch.Challenge)
	if len(want) != 64 {
		return 0, webErrorf(502, "invalid DeepSeek PoW challenge")
	}
	if _, err := hex.DecodeString(want); err != nil {
		return 0, webErrorf(502, "invalid DeepSeek PoW challenge")
	}
	prefix := ch.Salt + "_" + strconv.FormatInt(ch.ExpireAt, 10) + "_"
	for nonce := int64(0); nonce < ch.Difficulty; nonce++ {
		if nonce%4096 == 4095 {
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			default:
			}
		}
		digest := DeepSeekHashV1([]byte(prefix + strconv.FormatInt(nonce, 10)))
		if hex.EncodeToString(digest[:]) == want {
			return nonce, nil
		}
	}
	return 0, webErrorf(502, "DeepSeek PoW solution not found")
}

// PoWResponseHeader builds the x-ds-pow-response header value for a solved challenge.
func PoWResponseHeader(ch Challenge, answer int64) string {
	payload, _ := json.Marshal(map[string]any{
		"algorithm":   ch.Algorithm,
		"challenge":   ch.Challenge,
		"salt":        ch.Salt,
		"answer":      answer,
		"signature":   ch.Signature,
		"target_path": ch.TargetPath,
	})
	return base64.StdEncoding.EncodeToString(payload)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

// Client is a DeepSeek web API client. Credential is the userToken from
// chat.deepseek.com localStorage (or from SignIn); Cookies is the Cookie
// header value from the browser — required, the token alone does not work.
type Client struct {
	BaseURL    string
	Credential string
	Cookies    string
	HTTP       *http.Client
	deviceID   string
}

// NewClient builds a Client. A nil httpClient gets a default with a 2-minute timeout.
func NewClient(baseURL, credential, cookies string, httpClient *http.Client) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 120 * time.Second}
	}
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		Credential: credential,
		Cookies:    cookies,
		HTTP:       httpClient,
		deviceID:   newUUID(),
	}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// GenerateDeviceID returns a browser-style device id accepted by the web login
// endpoint (88-char base64 starting with 'B').
func GenerateDeviceID() string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	b := make([]byte, 85)
	_, _ = rand.Read(b)
	var sb strings.Builder
	sb.Grow(88)
	sb.WriteByte('B')
	for _, v := range b {
		sb.WriteByte(alphabet[int(v)%64])
	}
	sb.WriteString("==")
	return sb.String()
}

func baseHeaders() http.Header {
	return http.Header{
		"Content-Type": {"application/json"},
		"Accept":       {"application/json"},
		"Origin":       {DefaultBaseURL},
		"Referer":      {DefaultBaseURL + "/"},
		"User-Agent":   {userAgent},
	}
}

func (c *Client) sessionHeaders() http.Header {
	h := baseHeaders()
	h.Set("Authorization", "Bearer "+strings.TrimSpace(c.Credential))
	h.Set("X-App-Version", "2.0.0")
	h.Set("X-Client-Bundle-Id", "com.deepseek.chat")
	h.Set("X-Client-Platform", "web")
	h.Set("X-Client-Version", "2.0.0")
	h.Set("X-Client-Locale", "en_US")
	_, tzOffset := time.Now().Zone() // seconds east of UTC
	h.Set("X-Client-Timezone-Offset", strconv.Itoa(tzOffset))
	h.Set("X-Device-Id", c.deviceID)
	h.Set("X-Device-Model", "")
	h.Set("Accept-Language", "en")
	if strings.TrimSpace(c.Cookies) != "" {
		h.Set("Cookie", strings.TrimSpace(c.Cookies))
	}
	return h
}

type apiEnvelope struct {
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
}

type apiData struct {
	Code    *int            `json:"code"`
	BizCode int             `json:"biz_code"`
	BizMsg  string          `json:"biz_msg"`
	BizData json.RawMessage `json:"biz_data"`
}

// postAPI POSTs a JSON body with session headers and returns the inner biz_data.
func (c *Client) postAPI(ctx context.Context, path string, body any, extraHeaders map[string]string) (json.RawMessage, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, &buf)
	if err != nil {
		return nil, err
	}
	h := c.sessionHeaders()
	for k, v := range extraHeaders {
		h.Set(k, v)
	}
	req.Header = h
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, webErrorf(401, "deepseek token rejected — reconnect the account")
	}
	var env apiEnvelope
	if err := json.Unmarshal(respBody, &env); err != nil {
		return nil, webErrorf(mapStatus(resp.StatusCode), "deepseek %s returned invalid JSON (%d)", path, resp.StatusCode)
	}
	// A dead token answers code 40003 at the top level.
	if env.Code == 40003 {
		return nil, webErrorf(401, "deepseek token rejected — reconnect the account")
	}
	var d apiData
	if len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return nil, webErrorf(502, "deepseek %s returned invalid data envelope", path)
		}
	}
	if d.Code != nil && *d.Code != 0 {
		return nil, webErrorf(502, "deepseek %s failed (code %d)", path, *d.Code)
	}
	return d.BizData, nil
}

func mapStatus(s int) int {
	if s >= 500 {
		return 502
	}
	return s
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// LoginResult is the outcome of a sign-in attempt.
type LoginResult struct {
	OK         bool
	Credential string // session token when OK
	NeedCode   bool   // true when DeepSeek answered with an email verification challenge
	Message    string // human-readable message for the NeedCode case
	Err        string // error text when !OK && !NeedCode
}

func looksLikeVerificationChallenge(msg string) bool {
	m := strings.ToLower(msg)
	for _, sub := range []string{"verif", "2fa", "mfa", "one-time", "onetime", "otp", "security code", "securitycode", "check your email"} {
		if strings.Contains(m, sub) {
			return true
		}
	}
	return false
}

func loginError(status int, body string) string {
	switch status {
	case 400, 401, 403:
		return "email or password incorrect"
	case 429:
		return "too many sign-in attempts — wait a bit and retry"
	}
	t := body
	if len(t) > 160 {
		t = t[:160]
	}
	if t != "" {
		return fmt.Sprintf("deepseek sign-in failed (%d): %s", status, t)
	}
	return fmt.Sprintf("deepseek sign-in failed (%d)", status)
}

// SignIn signs in with a DeepSeek account — the same call the chat.deepseek.com
// web frontend makes. passwordHash must be the SHA-256 hex of the password so
// the plaintext password never leaves the caller's machine. Only the session
// token is returned; nothing is persisted.
//
// DeepSeek's risk control sometimes answers with an email verification
// challenge instead of a token: then LoginResult.NeedCode is true — prompt
// for the code and call SignIn again with verificationCode set.
//
// Note: every login invalidates the previous token for the account.
func SignIn(ctx context.Context, httpClient *http.Client, baseURL, email, passwordHash, verificationCode string) (*LoginResult, error) {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 120 * time.Second}
	}
	base := strings.TrimRight(baseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	body := map[string]string{
		"email":     email,
		"mobile":    "",
		"password":  passwordHash,
		"area_code": "",
		"device_id": GenerateDeviceID(),
		"os":        "web",
	}
	if code := strings.TrimSpace(verificationCode); code != "" {
		// Exact field name is undocumented; send the likely candidates.
		body["verification_code"] = code
		body["verify_code"] = code
		body["email_code"] = code
		body["code"] = code
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v0/users/login", &buf)
	if err != nil {
		return nil, err
	}
	req.Header = baseHeaders()
	resp, err := httpClient.Do(req)
	if err != nil {
		return &LoginResult{Err: err.Error()}, nil
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &LoginResult{Err: loginError(resp.StatusCode, string(respBody))}, nil
	}
	var env apiEnvelope
	if err := json.Unmarshal(respBody, &env); err != nil {
		return &LoginResult{Err: "deepseek sign-in returned invalid JSON"}, nil
	}
	var d apiData
	if len(env.Data) > 0 {
		_ = json.Unmarshal(env.Data, &d)
	}
	var user struct {
		Token string `json:"token"`
	}
	if len(d.BizData) > 0 {
		var biz struct {
			User *struct {
				Token string `json:"token"`
			} `json:"user"`
		}
		if uerr := json.Unmarshal(d.BizData, &biz); uerr == nil && biz.User != nil {
			user.Token = biz.User.Token
		}
	}
	if token := strings.TrimSpace(user.Token); token != "" {
		return &LoginResult{OK: true, Credential: token}, nil
	}
	if looksLikeVerificationChallenge(d.BizMsg) {
		msg := d.BizMsg
		if msg == "" {
			msg = "DeepSeek sent a verification code to your email — enter it to finish signing in."
		}
		return &LoginResult{NeedCode: true, Message: msg}, nil
	}
	if d.BizMsg != "" {
		return &LoginResult{Err: "deepseek sign-in failed: " + d.BizMsg}, nil
	}
	return &LoginResult{Err: "sign-in succeeded but DeepSeek returned no token"}, nil
}

// ResendCode best-effort resends the login verification code. DeepSeek usually
// emails the code automatically when the login is challenged.
func ResendCode(ctx context.Context, httpClient *http.Client, baseURL, email string) error {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 120 * time.Second}
	}
	base := strings.TrimRight(baseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	var buf bytes.Buffer
	_ = json.NewEncoder(&buf).Encode(map[string]string{"email": email, "scenario": "login"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v0/users/create_email_verification_code", &buf)
	if err != nil {
		return err
	}
	req.Header = baseHeaders()
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return webErrorf(mapStatus(resp.StatusCode), "could not resend the code (%d) — check your email anyway", resp.StatusCode)
	}
	return nil
}

// ValidateCredential is a lightweight credential check: create a chat session
// and delete it. A dead token answers code 40003.
func (c *Client) ValidateCredential(ctx context.Context) error {
	id, err := c.createChatSession(ctx)
	if err != nil {
		if we, ok := err.(*WebError); ok && we.Status == 401 {
			return webErrorf(401, "token rejected (invalid token) — sign in again and paste a fresh token")
		}
		return err
	}
	c.deleteChatSession(ctx, id) // best-effort
	return nil
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

func (c *Client) createChatSession(ctx context.Context) (string, error) {
	raw, err := c.postAPI(ctx, "/api/v0/chat_session/create", map[string]any{}, nil)
	if err != nil {
		return "", err
	}
	var data struct {
		ChatSession *struct {
			ID string `json:"id"`
		} `json:"chat_session"`
	}
	if err := json.Unmarshal(raw, &data); err != nil || data.ChatSession == nil || data.ChatSession.ID == "" {
		return "", webErrorf(502, "deepseek session create returned no id")
	}
	return data.ChatSession.ID, nil
}

// deleteChatSession is best-effort session cleanup; never returns an error.
func (c *Client) deleteChatSession(ctx context.Context, id string) {
	_, _ = c.postAPI(ctx, "/api/v0/chat_session/delete", map[string]any{"chat_session_id": id}, nil)
}

func (c *Client) createPowChallenge(ctx context.Context) (Challenge, error) {
	raw, err := c.postAPI(ctx, "/api/v0/chat/create_pow_challenge",
		map[string]any{"target_path": "/api/v0/chat/completion"}, nil)
	if err != nil {
		return Challenge{}, err
	}
	var data struct {
		Challenge *Challenge `json:"challenge"`
	}
	if err := json.Unmarshal(raw, &data); err != nil || data.Challenge == nil ||
		data.Challenge.Challenge == "" || data.Challenge.Salt == "" {
		return Challenge{}, webErrorf(502, "deepseek PoW challenge missing")
	}
	return *data.Challenge, nil
}

// ---------------------------------------------------------------------------
// Model options
// ---------------------------------------------------------------------------

// ResolvedModel carries DeepSeek web options for a turn.
type ResolvedModel struct {
	// ModelType is the DeepSeek web model_type: "default", "expert" or "thinking".
	ModelType       string
	ThinkingEnabled bool
	SearchEnabled   bool
}

// ResolveModel maps a requested model name to DeepSeek web options.
// Explicit markers always win (*think*/*r1* force DeepThink, *search* forces
// web search); otherwise the provider-level defaults apply.
func ResolveModel(requested string, thinkingDefault, searchDefault bool) ResolvedModel {
	n := strings.ToLower(strings.TrimSpace(requested))
	thinkingMarker := strings.Contains(n, "reasoner") || strings.Contains(n, "think") ||
		strings.Contains(n, "reason") || strings.Contains(n, "r1")
	searchMarker := strings.Contains(n, "search")
	thinking := thinkingMarker || thinkingDefault
	search := searchMarker || searchDefault
	expert := !thinking && (strings.Contains(n, "expert") || strings.Contains(n, "pro"))
	modelType := "default"
	switch {
	case thinking:
		modelType = "thinking"
	case expert:
		modelType = "expert"
	}
	return ResolvedModel{ModelType: modelType, ThinkingEnabled: thinking, SearchEnabled: search}
}

// ---------------------------------------------------------------------------
// SSE — DeepSeek speaks a JSON-patch protocol, not OpenAI SSE.
// ---------------------------------------------------------------------------

// Delta is one parsed think/answer fragment, a completion marker, or usage.
type Delta struct {
	Kind  string // "think", "answer", or "" for control deltas
	Text  string
	Done  bool
	Usage int64
	HasUsage bool
}

// DeltaState carries fragment-type context across SSE frames.
type DeltaState struct {
	FragmentType string
}

// ParseDelta parses one SSE data payload into think/answer deltas.
//
// Wire shapes:
//  {"v":{"response":{...,"fragments":[{"type":"THINK","content":".."}]}}}
//  {"p":"response/fragments/-1/content","o":"APPEND","v":".."}
//  {"v":".."}                          (bare continuation of the last path)
//  {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":".."}]}
//  {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":65}]}
//  {"p":"response/status","o":"SET","v":"FINISHED"}
func ParseDelta(payload string, state *DeltaState) []Delta {
	var obj struct {
		V any    `json:"v"`
		P string `json:"p"`
		O string `json:"o"`
	}
	if err := json.Unmarshal([]byte(payload), &obj); err != nil {
		return nil
	}
	kind := func() string {
		if state.FragmentType == "THINK" {
			return "think"
		}
		return "answer"
	}
	setFragmentType := func(frags any) {
		arr, ok := frags.([]any)
		if !ok || len(arr) == 0 {
			return
		}
		last, ok := arr[len(arr)-1].(map[string]any)
		if !ok {
			return
		}
		if t, ok := last["type"].(string); ok {
			state.FragmentType = strings.ToUpper(t)
		}
	}

	if obj.P != "" {
		p := obj.P
		switch {
		case p == "response/fragments":
			if arr, ok := obj.V.([]any); ok {
				setFragmentType(arr)
				if len(arr) > 0 {
					if last, ok := arr[len(arr)-1].(map[string]any); ok {
						if content, ok := last["content"].(string); ok && content != "" {
							return []Delta{{Kind: kind(), Text: content}}
						}
					}
				}
			}
			return nil
		case p == "response/fragments/-1/content" || strings.HasSuffix(p, "/content"):
			if s, ok := obj.V.(string); ok && s != "" {
				return []Delta{{Kind: kind(), Text: s}}
			}
			return nil
		case (p == "response/status" || p == "response/quasi_status") && obj.V == "FINISHED":
			return []Delta{{Done: true}}
		case p == "response" && obj.O == "BATCH":
			if arr, ok := obj.V.([]any); ok {
				for _, item := range arr {
					m, ok := item.(map[string]any)
					if !ok {
						continue
					}
					if m["p"] == "accumulated_token_usage" {
						if f, ok := m["v"].(float64); ok {
							return []Delta{{Usage: int64(f), HasUsage: true}}
						}
					}
				}
			}
			return nil
		}
		return nil
	}

	// Initial envelope: {"v":{"response":{...,"fragments":[...]}}}
	if vm, ok := obj.V.(map[string]any); ok {
		if resp, ok := vm["response"].(map[string]any); ok {
			if frags, ok := resp["fragments"]; ok {
				setFragmentType(frags)
				if arr, ok := frags.([]any); ok {
					var deltas []Delta
					for _, f := range arr {
						fm, ok := f.(map[string]any)
						if !ok {
							continue
						}
						content, ok := fm["content"].(string)
						if !ok || content == "" {
							continue
						}
						k := "answer"
						if t, ok := fm["type"].(string); ok && strings.ToUpper(t) == "THINK" {
							k = "think"
						}
						deltas = append(deltas, Delta{Kind: k, Text: content})
					}
					return deltas
				}
			}
		}
		return nil
	}

	// Bare continuation: {"v":"..."} — continues the last announced path.
	if s, ok := obj.V.(string); ok && s != "" {
		return []Delta{{Kind: kind(), Text: s}}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Chat turn
// ---------------------------------------------------------------------------

// Message is one OpenAI-format chat message; content is flattened to text.
type Message struct {
	Role    string
	Content string
}

// FlattenMessages flattens OpenAI messages into one prompt — disposable
// sessions carry no history.
func FlattenMessages(messages []Message) string {
	var parts []string
	for _, m := range messages {
		text := strings.TrimSpace(m.Content)
		if text == "" {
			continue
		}
		switch m.Role {
		case "system":
			parts = append(parts, text)
		case "assistant":
			parts = append(parts, "[Assistant]: "+text)
		default:
			parts = append(parts, "[User]: "+text)
		}
	}
	return strings.Join(parts, "\n\n")
}

// ChatOptions controls one chat turn.
type ChatOptions struct {
	Model           string // resolved DeepSeek model id (deepseek-chat)
	ResponseModel   string // model name reported back to the client
	Stream          bool
	ThinkingEnabled bool
	SearchEnabled   bool
}

// ChatResult is the outcome of one chat turn.
type ChatResult struct {
	Content   string
	Reasoning string
	Usage     int64
	// Stream is non-nil when ChatOptions.Stream is true: OpenAI-format SSE.
	Stream io.ReadCloser
}

func openAIChunk(id, model string, delta map[string]any, finish *string) string {
	choice := map[string]any{"index": 0, "delta": delta, "finish_reason": nil}
	if finish != nil {
		choice["finish_reason"] = *finish
	}
	obj := map[string]any{
		"id":      id,
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{choice},
	}
	b, _ := json.Marshal(obj)
	return "data: " + string(b) + "\n\n"
}

// sseLineReader reads an SSE stream and calls fn for each data payload.
func sseLineReader(r io.Reader, fn func(payload string) (done bool)) error {
	var buf strings.Builder
	tmp := make([]byte, 4096)
	flush := func() bool {
		for {
			s := buf.String()
			idx := strings.IndexByte(s, '\n')
			if idx < 0 {
				break
			}
			line := strings.TrimSpace(s[:idx])
			buf.Reset()
			buf.WriteString(s[idx+1:])
			if line == "" || !strings.HasPrefix(line, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "" || payload == "[DONE]" {
				continue
			}
			if fn(payload) {
				return true
			}
		}
		return false
	}
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			buf.Write(tmp[:n])
			if flush() {
				return nil
			}
		}
		if err != nil {
			if err == io.EOF {
				flush()
				return nil
			}
			return err
		}
	}
}

// ChatCompletion runs one DeepSeek web chat turn. It owns the disposable
// session lifecycle: create -> PoW -> completion -> delete.
//
// When opts.Stream is true, the returned ChatResult.Stream is an OpenAI-format
// SSE stream; the caller must close it. Otherwise Content/Reasoning/Usage are
// populated and Stream is nil.
func (c *Client) ChatCompletion(ctx context.Context, messages []Message, opts ChatOptions) (*ChatResult, error) {
	prompt := FlattenMessages(messages)
	if prompt == "" {
		return nil, webErrorf(400, "empty prompt")
	}
	resolved := ResolveModel(opts.Model, opts.ThinkingEnabled, opts.SearchEnabled)

	sessionID, err := c.createChatSession(ctx)
	if err != nil {
		return nil, err
	}
	finishSession := func() { c.deleteChatSession(context.Background(), sessionID) }

	challenge, err := c.createPowChallenge(ctx)
	if err != nil {
		finishSession()
		return nil, err
	}
	answer, err := SolvePoW(ctx, challenge)
	if err != nil {
		finishSession()
		return nil, err
	}

	compBody, _ := json.Marshal(map[string]any{
		"chat_session_id":  sessionID,
		"parent_message_id": nil,
		"model_type":       resolved.ModelType,
		"prompt":           prompt,
		"ref_file_ids":     []string{},
		"thinking_enabled": resolved.ThinkingEnabled,
		"search_enabled":   resolved.SearchEnabled,
		"action":           nil,
		"preempt":          false,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/v0/chat/completion", bytes.NewReader(compBody))
	if err != nil {
		finishSession()
		return nil, err
	}
	h := c.sessionHeaders()
	h.Set("Content-Type", "application/json")
	h.Set("X-Ds-Pow-Response", PoWResponseHeader(challenge, answer))
	req.Header = h

	upstream, err := c.HTTP.Do(req)
	if err != nil {
		finishSession()
		return nil, err
	}
	if ct := upstream.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		body, _ := io.ReadAll(upstream.Body)
		upstream.Body.Close()
		finishSession()
		text := strings.TrimSpace(string(body))
		switch upstream.StatusCode {
		case 401, 403:
			return nil, webErrorf(401, "deepseek token rejected — reconnect the account")
		case 429:
			return nil, webErrorf(429, "deepseek rate limited — account parked in cooldown")
		}
		suffix := ""
		if text != "" {
			if len(text) > 120 {
				text = text[:120]
			}
			suffix = ": " + text
		}
		return nil, webErrorf(mapStatus(upstream.StatusCode), "deepseek completions failed (%d)%s", upstream.StatusCode, suffix)
	}

	completionID := "chatcmpl-ds-" + sessionID
	if len(sessionID) > 8 {
		completionID = "chatcmpl-ds-" + sessionID[:8]
	}
	outModel := opts.ResponseModel
	if outModel == "" {
		outModel = opts.Model
	}

	// consume feeds parsed deltas to onDelta until FINISHED or EOF.
	consume := func(onDelta func(Delta)) error {
		defer finishSession()
		state := &DeltaState{}
		return sseLineReader(upstream.Body, func(payload string) bool {
			for _, d := range ParseDelta(payload, state) {
				onDelta(d)
				if d.Done {
					return true
				}
			}
			return false
		})
	}

	if !opts.Stream {
		defer upstream.Body.Close()
		var content, reasoning strings.Builder
		var usage int64
		if err := consume(func(d Delta) {
			switch d.Kind {
			case "think":
				reasoning.WriteString(d.Text)
			case "answer":
				content.WriteString(d.Text)
			}
			if d.HasUsage {
				usage = d.Usage
			}
		}); err != nil {
			return nil, err
		}
		if content.Len() == 0 && reasoning.Len() == 0 {
			return nil, webErrorf(502, "deepseek returned an empty completion")
		}
		return &ChatResult{Content: content.String(), Reasoning: reasoning.String(), Usage: usage}, nil
	}

	// Streaming: translate DeepSeek JSON-patch SSE to OpenAI chunks on the fly.
	pr, pw := io.Pipe()
	go func() {
		defer upstream.Body.Close()
		sentRole := false
		send := func(s string) {
			_, _ = io.WriteString(pw, s)
		}
		sendRole := func() {
			if !sentRole {
				sentRole = true
				send(openAIChunk(completionID, outModel, map[string]any{"role": "assistant", "content": ""}, nil))
			}
		}
		err := consume(func(d Delta) {
			if d.Kind != "" && d.Text != "" {
				sendRole()
				if d.Kind == "think" {
					send(openAIChunk(completionID, outModel, map[string]any{"reasoning_content": d.Text}, nil))
				} else {
					send(openAIChunk(completionID, outModel, map[string]any{"content": d.Text}, nil))
				}
			}
		})
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		stop := "stop"
		send(openAIChunk(completionID, outModel, map[string]any{}, &stop))
		send("data: [DONE]\n\n")
		_ = pw.Close()
	}()
	return &ChatResult{Stream: pr}, nil
}

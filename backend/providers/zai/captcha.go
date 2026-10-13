// Package zai — Aliyun captcha_verify_param generation.
//
// This implements the same method as the GLM-Free-API bridge (MIT licensed):
// the Aliyun CAPTCHA V3 flow that produces the captcha_verify_param every
// chat.z.ai completion request must carry.
//
// Flow:
//  1. InitCaptchaV3  → certifyId  (Aliyun, HMAC-SHA1 signed query)
//  2. generateArg(certifyId)      (RC4-like stream cipher over the certify id)
//  3. Track JSON → aliHash → zlib → base64 → encrypt (RC4-like, fixed key)
//  4. VerifyCaptchaV3(certifyId, data, deviceToken) → securityToken
//  5. captcha_verify_param = base64({"certifyId","isSign":true,
//     "sceneId","securityToken"})
//
// The deviceToken is the Aliyun device fingerprint (window.z_um.getToken()
// in the browser at chat.z.ai). The user pastes it alongside the JWT when
// connecting the account — it is stored per account, never harvested here.
package zai

import (
	"bytes"
	"compress/zlib"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// Aliyun CAPTCHA V3 credentials (same as the GLM-Free-API bridge).
// These are chat.z.ai's own public web-client credentials, not private secrets.
// They can also be supplied via ZAI_ALIYUN_ACCESS_KEY / ZAI_ALIYUN_SECRET_KEY
// env vars (useful when the compiled-in values were redacted by a scanner).
const (
	aliyunSceneID = "didk33e0"

	aliyunInitURL   = "https://no8xfe.captcha-open-southeast.aliyuncs.com/"
	aliyunVerifyURL = "https://no8xfe-verify.captcha-open-southeast.aliyuncs.com/"

	argConstant = "4xrihv8zb8tf1mfj"
	encryptKey  = "3e627e1b4c63f913"
)

var (
	aliyunAccessKey = firstNonEmpty(os.Getenv("ZAI_ALIYUN_ACCESS_KEY"), "3KceUCOX74KGpuZVyrM1fuk5GFR")
	aliyunSecretKey = firstNonEmpty(os.Getenv("ZAI_ALIYUN_SECRET_KEY"), "3KceUBs4fJj9iaOEBX7YycB9ACj")
)

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

var argPermTable = [64]int{
	32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30,
	60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49,
	18, 29, 27, 22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40,
	8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9, 0, 21,
}

// ---------------------------------------------------------------------------
// JSON types (field order and names must match exactly — payloads are hashed)
// ---------------------------------------------------------------------------

type initCaptchaResponse struct {
	CertifyID string `json:"CertifyId"`
}

type cvpPayload struct {
	CertifyID   string `json:"certifyId"`
	Data        string `json:"data"`
	DeviceToken string `json:"deviceToken"`
	SceneID     string `json:"sceneId"`
}

type verifyCaptchaResponse struct {
	Success bool `json:"Success"`
	Result  struct {
		VerifyResult  bool   `json:"VerifyResult"`
		SecurityToken string `json:"securityToken"`
		CertifyID     string `json:"certifyId"`
	} `json:"Result"`
}

type finalPayload struct {
	CertifyID     string `json:"certifyId"`
	IsSign        bool   `json:"isSign"`
	SceneID       string `json:"sceneId"`
	SecurityToken string `json:"securityToken"`
}

type trackList struct {
	FI        string `json:"fi"`
	KS        string `json:"ks"`
	MC        string `json:"mc"`
	MP        string `json:"mp"`
	MU        string `json:"mu"`
	StartTime int64  `json:"startTime"`
	TC        string `json:"tc"`
	TE        string `json:"te"`
	TMV       string `json:"tmv"`
}

type track struct {
	TrackList      trackList `json:"TrackList"`
	TrackStartTime int64     `json:"TrackStartTime"`
	VerifyTime     int64     `json:"VerifyTime"`
	Arg            string    `json:"arg"`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

var urlSafeTable [256]bool

func init() {
	for i := 0; i < 256; i++ {
		c := byte(i)
		if (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			urlSafeTable[i] = true
		}
	}
}

const hexUpper = "0123456789ABCDEF"

func aliyunURLEncode(s string) string {
	var b strings.Builder
	b.Grow(len(s)*3 + 16)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if urlSafeTable[c] {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hexUpper[c>>4])
			b.WriteByte(hexUpper[c&0x0F])
		}
	}
	return b.String()
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return 0
	}
}

func hmacSHA1B64(key, msg []byte) string {
	h := hmac.New(sha1.New, key)
	h.Write(msg)
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func newNonce() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func utcTimestamp() string { return time.Now().UTC().Format("2006-01-02T15:04:05Z") }

// jsonNoEscape marshals without HTML escaping (matches the reference method).
func jsonNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	b := buf.Bytes()
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
	}
	return b, nil
}

// ---------------------------------------------------------------------------
// Aliyun request signing (HMAC-SHA1, same as the reference method)
// ---------------------------------------------------------------------------

func aliyunSignature(params map[string]string, secKey string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var canonical strings.Builder
	for i, k := range keys {
		if i > 0 {
			canonical.WriteByte('&')
		}
		canonical.WriteString(aliyunURLEncode(k))
		canonical.WriteByte('=')
		canonical.WriteString(aliyunURLEncode(params[k]))
	}
	stringToSign := "POST&" + aliyunURLEncode("/") + "&" + aliyunURLEncode(canonical.String())
	return hmacSHA1B64([]byte(secKey+"&"), []byte(stringToSign))
}

func buildQueryString(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(aliyunURLEncode(k))
		b.WriteByte('=')
		b.WriteString(aliyunURLEncode(params[k]))
	}
	return b.String()
}

func aliyunPost(httpClient *http.Client, targetURL, body string, referer string) (string, error) {
	req, err := http.NewRequest(http.MethodPost, targetURL, strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	req.Header.Set("Referer", referer)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ---------------------------------------------------------------------------
// Step 1: InitCaptchaV3
// ---------------------------------------------------------------------------

func initCaptcha(httpClient *http.Client) (string, error) {
	params := map[string]string{
		"AccessKeyId":      aliyunAccessKey,
		"Action":           "InitCaptchaV3",
		"Format":           "JSON",
		"Language":         "en",
		"Mode":             "popup",
		"SceneId":          aliyunSceneID,
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureNonce":   newNonce(),
		"SignatureVersion": "1.0",
		"Timestamp":        utcTimestamp(),
		"UpLang":           "true",
		"Version":          "2023-03-05",
	}
	params["Signature"] = aliyunSignature(params, aliyunSecretKey)
	resp, err := aliyunPost(httpClient, aliyunInitURL, buildQueryString(params), "")
	if err != nil {
		return "", err
	}
	var result initCaptchaResponse
	if err := json.Unmarshal([]byte(resp), &result); err != nil {
		return "", fmt.Errorf("parse InitCaptchaV3 response: %w", err)
	}
	if result.CertifyID == "" {
		return "", fmt.Errorf("InitCaptchaV3 returned empty certifyId: %s", resp)
	}
	return result.CertifyID, nil
}

// ---------------------------------------------------------------------------
// Step 2: generateArg — RC4-like stream cipher over the certify id
// ---------------------------------------------------------------------------

func generateArg(certifyID string) string {
	encoded := aliyunURLEncode(certifyID)
	o := make([]byte, 0, len(encoded))
	for i := 0; i < len(encoded); {
		if encoded[i] == '%' && i+2 < len(encoded) {
			o = append(o, hexVal(encoded[i+1])<<4|hexVal(encoded[i+2]))
			i += 3
		} else {
			o = append(o, encoded[i])
			i++
		}
	}

	r := argPermTable
	n := argConstant
	rlen := 64
	i, j := 0, 0
	for i < rlen {
		j = (((i + j + r[i] + r[j]) >> 1) + int(n[i%len(n)])) & (rlen - 1)
		if i != j {
			r[i], r[j] = r[j], r[i]
		}
		i++
	}

	t := make([]byte, 0, len(o))
	e, a := 0, 0
	for idx := 0; idx < len(o); idx++ {
		a = ((e ^ a) + (r[e] ^ r[a])) & (rlen - 1)
		if e != a {
			r[e], r[a] = r[a], r[e]
		}
		m := int(o[idx])
		m = m + e + r[e] - a - r[a]
		m = m ^ (r[e] + r[a])
		m = m ^ r[(r[e]+r[a])&(rlen-1)]
		m = m & 255
		t = append(t, byte(m))
		e = (e + 1) & (rlen - 1)
	}
	return base64.StdEncoding.EncodeToString(t)
}

// ---------------------------------------------------------------------------
// Step 3: aliHash — custom 16-byte-state hash
// ---------------------------------------------------------------------------

const hexLower = "0123456789abcdef"

func aliHash(inputStr, saltStr string) string {
	o := inputStr
	r := saltStr
	aLen := len(o)
	m := len(r)

	var e [16]int
	for i := 0; i < 16; i++ {
		e[i] = (i << 4) + (i % 16)
	}
	f := 16

	i, j := 0, 0
	for i < f {
		j = (((i + j + e[i] + e[j]) >> 1) + int(r[i%m])) & (f - 1)
		e[i], e[j] = e[j], e[i]
		i++
	}

	idx, p, q := 0, 0, 0
	for idx < aLen {
		q = ((p ^ q) + (e[p] ^ e[q])) & (f - 1)
		e[p], e[q] = e[q], e[p]
		C := int(o[idx])
		C = (C + p + q) ^ e[p] ^ e[q]
		C = C & 255
		e[p] = C
		p = (p + 1) & (f - 1)
		idx++
	}

	for step := 0; step < 2*f; step++ {
		pos := step % f
		if pos != 0 {
			e[pos] ^= e[pos-1]
		} else {
			e[0] ^= e[f-1]
		}
	}

	var result [32]byte
	for i, b := range e {
		result[i*2] = hexLower[(b>>4)&0xF]
		result[i*2+1] = hexLower[b&0xF]
	}
	return string(result[:])
}

// ---------------------------------------------------------------------------
// Step 4: encrypt — same RC4-like cipher, different key
// ---------------------------------------------------------------------------

func captchaEncrypt(plaintext []byte) string {
	o := plaintext
	n := encryptKey
	r := argPermTable
	rlen := 64

	oKsa, tKsa := 0, 0
	for oKsa < rlen {
		tKsa = (((oKsa + tKsa + r[oKsa] + r[tKsa]) >> 1) + int(n[oKsa%len(n)])) & (rlen - 1)
		if oKsa != tKsa {
			r[oKsa], r[tKsa] = r[tKsa], r[oKsa]
		}
		oKsa++
	}

	t := make([]byte, 0, len(o))
	e, a := 0, 0
	for nPrga := 0; nPrga < len(o); nPrga++ {
		a = ((e ^ a) + (r[e] ^ r[a])) & (rlen - 1)
		if e != a {
			r[e], r[a] = r[a], r[e]
		}
		m := int(o[nPrga])
		m = m + e + r[e] - a - r[a]
		m = m ^ (r[e] + r[a])
		m = m ^ r[(r[e]+r[a])&(rlen-1)]
		m = m & 255
		t = append(t, byte(m))
		e = (e + 1) & (rlen - 1)
	}
	return base64.StdEncoding.EncodeToString(t)
}

func zlibCompress(data []byte) []byte {
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	_, _ = w.Write(data)
	_ = w.Close()
	return buf.Bytes()
}

// ---------------------------------------------------------------------------
// Step 5: VerifyCaptchaV3
// ---------------------------------------------------------------------------

func verifyCaptcha(httpClient *http.Client, certifyID, dataValue, deviceToken string) (string, error) {
	cvpJSON, err := jsonNoEscape(cvpPayload{
		CertifyID:   certifyID,
		Data:        dataValue,
		DeviceToken: deviceToken,
		SceneID:     aliyunSceneID,
	})
	if err != nil {
		return "", err
	}
	params := map[string]string{
		"AccessKeyId":        aliyunAccessKey,
		"Action":             "VerifyCaptchaV3",
		"Format":             "JSON",
		"SignatureMethod":    "HMAC-SHA1",
		"SignatureVersion":   "1.0",
		"Timestamp":          utcTimestamp(),
		"Version":            "2023-03-05",
		"SceneId":            aliyunSceneID,
		"CertifyId":          certifyID,
		"CaptchaVerifyParam": string(cvpJSON),
		"SignatureNonce":     newNonce(),
	}
	params["Signature"] = aliyunSignature(params, aliyunSecretKey)
	resp, err := aliyunPost(httpClient, aliyunVerifyURL, buildQueryString(params), "")
	if err != nil {
		return "", err
	}
	var respJSON verifyCaptchaResponse
	if err := json.Unmarshal([]byte(resp), &respJSON); err != nil {
		return "", fmt.Errorf("parse VerifyCaptchaV3 response: %w", err)
	}
	if respJSON.Success && respJSON.Result.VerifyResult {
		st := respJSON.Result.SecurityToken
		ci := respJSON.Result.CertifyID
		if st != "" && ci != "" {
			fpJSON, err := jsonNoEscape(finalPayload{
				CertifyID:     ci,
				IsSign:        true,
				SceneID:       aliyunSceneID,
				SecurityToken: st,
			})
			if err != nil {
				return "", err
			}
			return base64.StdEncoding.EncodeToString(fpJSON), nil
		}
		return "", fmt.Errorf("VerifyCaptchaV3 succeeded but securityToken/certifyId empty")
	}
	return "", fmt.Errorf("VerifyCaptchaV3 failed: %s", resp)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// captchaComputeOverride, when non-empty, is returned by the captcha step
// instead of hitting the real Aliyun flow. Test seam only.
var captchaComputeOverride string

// ComputeCaptchaParam runs the full Aliyun flow and returns the
// captcha_verify_param for one chat request. deviceToken is the Aliyun device
// fingerprint from the user's browser (window.z_um.getToken() at chat.z.ai).
// The param is cached briefly (60s) since generation costs ~10s of signing.
func ComputeCaptchaParam(httpClient *http.Client, deviceToken string) (string, error) {
	if captchaComputeOverride != "" {
		return captchaComputeOverride, nil
	}
	if strings.TrimSpace(deviceToken) == "" {
		return "", fmt.Errorf("device token pool empty — collecting 20 tokens in the background, retry in about a minute (or collect manually on the Setup page)")
	}
	if v, ok := captchaCache.get(); ok {
		return v, nil
	}
	certifyID, err := initCaptcha(httpClient)
	if err != nil {
		return "", fmt.Errorf("initCaptcha: %w", err)
	}
	argValue := generateArg(certifyID)
	ct := time.Now().UnixMilli()
	trackJSON, err := jsonNoEscape(track{
		TrackList:      trackList{StartTime: ct},
		TrackStartTime: ct,
		VerifyTime:     ct + 300,
		Arg:            argValue,
	})
	if err != nil {
		return "", err
	}
	combined := aliHash(string(trackJSON), "0000") + string(trackJSON)
	finalVal := captchaEncrypt(zlibCompress([]byte(combined)))
	param, err := verifyCaptcha(httpClient, certifyID, finalVal, deviceToken)
	if err != nil {
		return "", err
	}
	captchaCache.set(param)
	return param, nil
}

// captchaCache holds one generated param for 60s.
type captchaCacheT struct {
	mu      sync.Mutex
	value   string
	expires time.Time
}

var captchaCache captchaCacheT

func (c *captchaCacheT) get() (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.value != "" && time.Now().Before(c.expires) {
		return c.value, true
	}
	return "", false
}

func (c *captchaCacheT) set(v string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.value = v
	c.expires = time.Now().Add(60 * time.Second)
}

// Package prometheus renders process metrics in the Prometheus text
// exposition format for the /metrics endpoint.
// https://prometheus.io/docs/instrumenting/exposition_formats/
package prometheus

import (
	"net/http"
	"strings"

	"github.com/mcptears/opencode-max/metrics"
)

// AccountStatus is the minimal per-account status needed for /metrics.
// It intentionally mirrors only the fields we export (no secrets).
type AccountStatus struct {
	ID       string
	Inflight int
}

// PoolStatusProvider supplies per-account status. Implemented by the
// account pool; defined here as an interface so this package does not
// depend on the pool package.
type PoolStatusProvider interface {
	Status() []AccountStatus
}

func escLabel(v string) string {
	v = strings.ReplaceAll(v, "\\", "\\\\")
	v = strings.ReplaceAll(v, "\"", "\\\"")
	v = strings.ReplaceAll(v, "\n", "\\n")
	return v
}

func counter(name, help string, value int64, labels string) string {
	return "# HELP " + name + " " + help + "\n# TYPE " + name + " counter\n" +
		name + labels + " " + itoa(value) + "\n"
}

func gauge(name, help string, value int64, labels string) string {
	return "# HELP " + name + " " + help + "\n# TYPE " + name + " gauge\n" +
		name + labels + " " + itoa(value) + "\n"
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// Render produces the Prometheus text body for the current counters
// (no secrets). Pool may be nil.
func Render(m *metrics.Metrics, pool PoolStatusProvider) string {
	var out strings.Builder
	s := m.Summary()
	out.WriteString(counter("opencode_max_requests_total", "Total proxied requests", s.Requests, ""))
	out.WriteString(counter("opencode_max_successes_total", "Requests that reached upstream without retryable error", s.Successes, ""))
	out.WriteString(counter("opencode_max_rate_limited_total", "Upstream 429 / quota hits", s.RateLimited, ""))
	out.WriteString(counter("opencode_max_rotations_total", "Egress IP rotations", s.Rotations, ""))
	out.WriteString(counter("opencode_max_retries_total", "Transparent upstream retries", s.Retries, ""))
	out.WriteString(counter("opencode_max_failovers_total", "Cross-provider and model fallbacks", s.Failovers, ""))
	out.WriteString(counter("opencode_max_tokens_saved_total", "Approximate tokens saved by the token saver", s.TokensSaved, ""))
	out.WriteString(gauge("opencode_max_uptime_seconds", "Process uptime in seconds", s.UptimeSec, ""))
	ids := make([]string, 0, len(s.PerAccount))
	for id := range s.PerAccount {
		ids = append(ids, id)
	}
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0 && ids[j] < ids[j-1]; j-- {
			ids[j], ids[j-1] = ids[j-1], ids[j]
		}
	}
	for _, id := range ids {
		out.WriteString(counter("opencode_max_account_requests_total", "Proxied requests per account",
			s.PerAccount[id], `{account="`+escLabel(id)+`"}`))
	}
	if pool != nil {
		for _, a := range pool.Status() {
			out.WriteString(gauge("opencode_max_account_inflight", "Currently in-flight requests per account",
				int64(a.Inflight), `{account="`+escLabel(a.ID)+`"}`))
		}
	}
	return out.String()
}

// Handler returns an http.HandlerFunc serving the Prometheus text format.
func Handler(m *metrics.Metrics, pool PoolStatusProvider) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(Render(m, pool)))
	}
}

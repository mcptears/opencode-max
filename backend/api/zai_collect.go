package api

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Background Z.ai device-token collection. The harvester is the separate
// zai-collect binary (Playwright); this runs it as a subprocess so the
// server binary stays lean.

var (
	zaiCollectRunning atomic.Bool
	zaiCollectMu      sync.Mutex
	zaiCollectLogBuf  bytes.Buffer
)

func zaiCollectLog() string {
	zaiCollectMu.Lock()
	defer zaiCollectMu.Unlock()
	out := zaiCollectLogBuf.String()
	if len(out) > 4000 {
		out = out[len(out)-4000:]
	}
	return out
}

func zaiCollectAppend(s string) {
	zaiCollectMu.Lock()
	defer zaiCollectMu.Unlock()
	zaiCollectLogBuf.WriteString(s)
	if zaiCollectLogBuf.Len() > 8000 {
		zaiCollectLogBuf.Next(zaiCollectLogBuf.Len() - 8000)
	}
}

// findZaiCollect locates the zai-collect binary next to the server binary,
// else on PATH.
func findZaiCollect() string {
	if exe, err := os.Executable(); err == nil {
		cand := filepath.Join(filepath.Dir(exe), "zai-collect")
		if _, err := os.Stat(cand); err == nil {
			return cand
		}
		// Windows.
		if _, err := os.Stat(cand + ".exe"); err == nil {
			return cand + ".exe"
		}
	}
	if p, err := exec.LookPath("zai-collect"); err == nil {
		return p
	}
	return ""
}

// TriggerZaiCollect starts a background device-token harvest unless one is
// already running. Safe to call from non-api packages (e.g. wire).
// Legacy single-batch form used by the pool-empty auto-collect.
func TriggerZaiCollect(count int) {
	if zaiCollectRunning.Load() {
		return
	}
	if count <= 0 {
		count = 20
	}
	zaiCollectRunning.Store(true)
	go runZaiCollectOpts(ZaiCollectOptions{Count: count})
}

// ZaiCollectOptions mirrors the zai-collect CLI flags. Count, when set,
// wins (single batch of exactly Count tokens — dashboard quick collect).
// Otherwise Tokens x Batches drives the full multi-batch run.
type ZaiCollectOptions struct {
	Count         int  `json:"count"`
	Tokens        int  `json:"tokens"`
	Batches       int  `json:"batches"`
	Parallel      int  `json:"parallel"`
	Headed        bool `json:"headed"`
	BlockTrackers bool `json:"blockTrackers"`
	Unsafe        bool `json:"unsafe"`
}

// RunZaiCollectOpts starts a background harvest with the given options
// unless one is already running.
func RunZaiCollectOpts(o ZaiCollectOptions) bool {
	if zaiCollectRunning.Load() {
		return false
	}
	zaiCollectRunning.Store(true)
	go runZaiCollectOpts(o)
	return true
}

func runZaiCollectOpts(o ZaiCollectOptions) {
	defer zaiCollectRunning.Store(false)
	bin := findZaiCollect()
	if bin == "" {
		zaiCollectAppend("zai-collect binary not found next to the server or on PATH\n")
		return
	}
	args := []string{}
	switch {
	case o.Count > 0:
		args = append(args, "--count", strconv.Itoa(o.Count))
	default:
		tokens := o.Tokens
		if tokens <= 0 {
			tokens = 850
		}
		batches := o.Batches
		if batches <= 0 {
			batches = 5
		}
		args = append(args, "--tokens", strconv.Itoa(tokens), "--batch", strconv.Itoa(batches))
		if o.Parallel > 1 {
			args = append(args, "--parallel", strconv.Itoa(o.Parallel))
		}
		if o.Headed {
			args = append(args, "--headed")
		}
		if o.BlockTrackers {
			args = append(args, "--block-trackers")
		}
		if o.Unsafe {
			args = append(args, "--unsafe")
		}
	}
	zaiCollectAppend(time.Now().Format("15:04:05") + " starting collection...\n")
	cmd := exec.Command(bin, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	zaiCollectAppend(out.String())
	if err != nil {
		zaiCollectAppend("collection failed: " + err.Error() + "\n")
		return
	}
	zaiCollectAppend("collection finished\n")
}

func runZaiCollect(count int) {
	runZaiCollectOpts(ZaiCollectOptions{Count: count})
}

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

func runZaiCollect(count int) {
	defer zaiCollectRunning.Store(false)
	bin := findZaiCollect()
	if bin == "" {
		zaiCollectAppend("zai-collect binary not found next to the server or on PATH\n")
		return
	}
	zaiCollectAppend(time.Now().Format("15:04:05") + " starting collection...\n")
	cmd := exec.Command(bin, "--count", strconv.Itoa(count))
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

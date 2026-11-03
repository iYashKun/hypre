package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

const hypreVersion = "0.3.4"

func run() int {
	args := append(
		[]string{
			"exec",
			"--yes",
			"--package=@yashkun/hypre@" + hypreVersion,
			"--",
			"hypre",
		},
		os.Args[1:]...,
	)

	cmd := exec.Command("npm", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	signals := make(chan os.Signal, 1)
	done := make(chan struct{})
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case received := <-signals:
			if cmd.Process != nil {
				_ = cmd.Process.Signal(received)
			}
		case <-done:
		}
	}()

	if err := cmd.Wait(); err != nil {
		close(done)
		signal.Stop(signals)
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if code := exitErr.ExitCode(); code >= 0 {
				return code
			}
			return 1
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	close(done)
	signal.Stop(signals)
	return 0
}

func main() {
	os.Exit(run())
}

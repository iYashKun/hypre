package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

func main() {
	args := append(
		[]string{
			"exec",
			"--yes",
			"--package=@yashkun/hypre@latest",
			"--",
			"hypre",
		},
		os.Args[1:]...,
	)

	cmd := exec.Command("npm", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin  = os.Stdin

	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

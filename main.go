package main

import (
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
		os.Exit(1)
	}
}

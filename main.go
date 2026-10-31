package main

import (
    "os"
    "os/exec"
)

func main() {
    args := append(
        []string{"--yes", "@yashkun/hypre@latest"},
        os.Args[1:]...,
    )

    cmd := exec.Command("npx", args...)
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    cmd.Stdin = os.Stdin

    if err := cmd.Run(); err != nil {
        os.Exit(1)
    }
}

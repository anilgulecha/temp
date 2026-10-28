# Agent 100 2.0 — try-out (spike)

A throwaway public repo to try the Agent 100 2.0 helper on real macOS and Windows. Not published to npm.

Agent 100 gives a lab page in the browser **real bash and files on your computer**:

- It listens on `127.0.0.1` only.
- It answers only a page that has the pairing code it prints.
- File actions are limited to your home folder.
- Commands run as you in bash, starting in the lab's folder `~/kiterooms/<lab>`.
- On Windows it runs itself inside WSL. It asks before it installs WSL, Ubuntu's first user or Node there.

## Run it

You need Node 20 or later.

```sh
npx -y https://github.com/anilgulecha/temp/archive/main.tar.gz
```

It prints a code such as `a100-4777-…` for the lab page. Ctrl-C stops it. On Windows, run it in PowerShell; it runs inside WSL. If you already use WSL, you can also run the same command inside it.

## Test it

```sh
git clone https://github.com/anilgulecha/temp && cd temp
node test.mjs                                             # this checkout, in a throwaway home folder
node test.mjs --cmd "npx -y https://github.com/anilgulecha/temp/archive/main.tar.gz"      # through npx, as a student runs it
node test.mjs --no-home --cmd "node a100.mjs"             # Windows: Agent 100 runs in WSL with its own home
```

`test.mjs` starts Agent 100 and checks its answers over HTTP. No browser, no model, no keys:

- the pairing code, and the DNS-rebinding guard
- the home-folder fence, including `..` and symlinks
- files
- real bash: output, exit codes, environment variables, timeout, Stop
- running a command once when it is asked again (a page reload)
- stopping when its terminal closes

Agent 100 has no rules about Teachers or students. Those belong to the lab page.

The `try` workflow runs it on macOS (Apple silicon and Intel) and on Windows, both directly and through WSL.

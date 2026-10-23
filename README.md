# CoreLab

CoreLab is an offline-first operations training prototype for Kubernetes and Linux. Its first mission asks you to inspect a simulated cluster, find and edit a Deployment manifest, apply it, and verify service connectivity.

## Start

Open `index.html` in a desktop browser. It has no package install, container runtime, account, or cloud dependency. The default language is English (UK); Japanese, Korean, and Traditional Chinese are also available.

## Shell interaction

The virtual shell starts in `/home/operator`. Its files and directories exist only in the simulator. Use the shell to discover them; the YAML is not shown in the workspace until you inspect or edit it.

- Linux basics: `pwd`, `ls`, `ll`, `cd`, `tree`, `cat`, `less`, `head`, `tail`, `grep`, `find`, `mkdir`, `touch`, `cp`, `mv`, `rm`, `echo`, `history`, `vi`, `ip`, `ping`, `route`, `dig`, `ss`, `df`, `free`, `ps`
- Kubernetes: `kubectl` (also `k`), resource shortcuts such as `no`, `po`, `deploy`, `svc`, `ep`, `ns`, `cm`, and `ds`; `get`, `describe`, `logs`, `apply -f`, `exec`, `rollout status`, and `config current-context`
- Docker: `docker ps`, `images`, `logs`, `inspect`, `exec`, `start`, `stop`, `version`, and `compose ps`
- Keyboard: Tab completes commands, resource names, paths, and filenames; Up/Down recalls command history; Ctrl+C or Esc clears the shell input.
- Editor: `vi <file>` opens the simulated editor. Tab inserts indentation, Ctrl+S or `:w` saves, `:wq` saves and exits, and `:q!` exits while discarding edits.

The mission offers a separate hint button at each objective. After all three are complete, **Continue to free-build lab** opens the sandbox mode. Use the reset button to restart the mission and restore the original virtual files.

## Simulation boundary

All shell commands, Kubernetes resources, files, and Docker output are simulated in browser memory. Linux file operations affect only the virtual workspace. No command reaches the Windows filesystem, a Docker daemon, a Kubernetes cluster, AWS, or the network. This prototype supports a practical command subset; it does not implement complete Linux, Kubernetes, Docker, or Vim behaviour.

## Project files

- `index.html` — application structure and editor dialog
- `app.css` — layout, readable type, responsive styles, and editor appearance
- `app.js` — virtual filesystem, shell, Kubernetes and Docker command simulation, mission state, and translations

The topology, addresses, image names, and logs are fictional teaching data. They do not encode a Docomo design or represent a verified AWS/Kubernetes procedure.

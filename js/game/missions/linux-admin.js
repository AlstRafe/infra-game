/* Track: Linux basics, missions 3-8 — the server administration of LPIC-1 / LFCS / RHCSA:
 * accounts and shared directories, a runaway process and its cron job, a new disk and fstab,
 * a systemd unit that does not come back after a reboot, firewalld, and growing an LVM volume. */
(function (IG) {
  "use strict";
  const HOME = "/home/operator";
  const host = (w, name) => w.hosts[name];
  const mountAt = (h, dir) => IG.mounts(h).find((m) => m.target === dir);
  // lines of a file that are not blank or comments
  const active = (text) =>
    String(text || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  // Commands run on a host while the mission is set up (before the player arrives).
  function prepare(w, name, lines) {
    const sh = new IG.Shell(w);
    sh.exec("ssh " + name);
    for (const l of lines) {
      const r = sh.exec(l);
      if (r.code) throw new Error(`setup of ${name} failed: ${l}\n${r.out}`);
    }
  }

  /* ---------------------------------------------------------------- 3. accounts and groups */
  IG.registerMission({
    id: "basics-03",
    track: "basics",
    order: 3,
    difficulty: 2,
    par: 420,
    xp: 160,
    title: "共有ディレクトリに書き込めない",
    summary: "新メンバーのアカウントを作り、グループと権限でリリース置き場を共有する",
    story: [
      "リリース担当チームに新メンバーの bob さんが加わりました。成果物の置き場 /srv/releases は今まで alice さん一人で使っていたため、ほかの人は書き込めません。",
      "依頼は「bob のアカウントを作り、deploy グループの全員が /srv/releases にファイルを置けるようにしてほしい。誰が置いたファイルでもグループで更新できるように」。",
      "サーバー app-01 に SSH して対応してください。",
    ],
    cwd: HOME,
    setup(w, B) {
      w.addHost("app-01", { user: "ubuntu", ip: "10.0.1.41", users: [{ name: "alice" }] });
      const h = host(w, "app-01");
      h.groups.deploy = { gid: 1002, members: new Set(["alice"]) };
      h.syncAccounts();
      const own = { owner: "alice", group: "alice" };
      h.vfs.mkdirp("/srv/releases", Object.assign({ mode: 0o755 }, own));
      h.vfs.write("/srv/releases/app-1.4.0.tar.gz", "", Object.assign({ size: 18874368 }, own));
      h.vfs.write(
        "/srv/releases/RELEASES.md",
        "# Releases\n\n- 1.4.0 (2026-11-12) alice\n",
        Object.assign({ mode: 0o644 }, own),
      );
      B.files(w, {
        [HOME + "/tickets/REQ-3107.txt"]: IG.t(
          "依頼: 新メンバー bob の受け入れ\n- サーバー: app-01 (10.0.1.41) / ユーザー ubuntu（sudo 可）\n- bob のアカウントを作成（ホームディレクトリあり・シェルは bash）\n- deploy グループ（alice ほか）に追加\n- /srv/releases を deploy グループで共有。誰が置いたファイルもグループで更新できること\n",
        ),
      });
    },
    objectives: [
      {
        title: "bob のアカウントを作る",
        detail: "ホームディレクトリ付きで bob を作成し、deploy グループに入れる",
        hints: [
          "`sudo useradd` でユーザーを作ります。-m でホームディレクトリ、-s でログインシェル、-G で追加のグループを指定できます。",
          "`sudo useradd -m -s /bin/bash -G deploy bob` で作成し、`id bob` で所属グループを確認しましょう（作成済みなら `sudo usermod -aG deploy bob`）。",
        ],
        check: (w) => {
          const h = host(w, "app-01");
          const u = h.users.bob;
          return !!u && h.vfs.isDir(u.home) && h.inGroup("bob", "deploy");
        },
      },
      {
        title: "/srv/releases をグループで共有する",
        detail:
          "既存のファイルも含めて所有グループを deploy にしてグループで書き込めるようにし、新しいファイルも deploy グループになるようにする",
        hints: [
          "`ls -l /srv/releases` と `ls -ld /srv/releases` で所有者・グループ・権限を確認。グループは `chgrp`、権限は `chmod` で変えます。-R を付けると中のファイルもまとめて変わります。",
          "`sudo chgrp -R deploy /srv/releases` → `sudo chmod -R g+w /srv/releases` で既存のファイルもそろえ、`sudo chmod g+s /srv/releases`（setgid: 中に作ったファイルがディレクトリのグループを引き継ぐ）。",
        ],
        check: (w) => {
          const v = host(w, "app-01").vfs;
          const n = v.node("/srv/releases");
          const shared = (x) => !!x && x.group === "deploy" && !!(x.mode & 0o020);
          return (
            shared(n) &&
            (n.mode & 0o070) === 0o070 &&
            !!(n.mode & 0o2000) &&
            v.walk("/srv/releases").every((p) => shared(v.node(p)))
          );
        },
      },
      {
        title: "bob として置けることを確かめる",
        detail: "bob の権限で /srv/releases にファイルを作り、グループが deploy になることを確認する",
        hints: [
          "`sudo -u bob <コマンド>` で bob として実行できます。",
          "`sudo -u bob touch /srv/releases/bob-test.txt` のあと `ls -l /srv/releases` で、所有者 bob・グループ deploy になっていれば OK。",
        ],
        check: (w) => {
          const v = host(w, "app-01").vfs;
          return v.walk("/srv/releases").some((p) => {
            const n = v.node(p);
            return n && n.owner === "bob" && n.group === "deploy";
          });
        },
      },
    ],
    solution: [
      "ssh app-01",
      "ls -ld /srv/releases",
      "sudo useradd -m -s /bin/bash -G deploy bob",
      "id bob",
      "sudo chgrp -R deploy /srv/releases",
      "sudo chmod -R g+w /srv/releases",
      "sudo chmod g+s /srv/releases",
      "sudo -u bob touch /srv/releases/bob-test.txt",
      "ls -l /srv/releases",
    ],
    debrief: {
      points: [
        "useradd -m -s /bin/bash -G <グループ> でホーム・シェル・所属をまとめて指定できる。既存ユーザーへの追加は usermod -aG（-a を忘れるとほかのグループから外れる）。",
        "共有ディレクトリは「所有グループ + グループの書き込み + setgid（chmod 2775 や g+s）」が定番。setgid があると、中に作ったファイルがディレクトリのグループを引き継ぐ。既存のファイルは chgrp -R と chmod -R g+w でそろえる。",
        "グループの追加がログイン中のセッションに効くのは再ログインの後。動作確認は sudo -u <ユーザー> で本人として試すと確実。",
      ],
      commands: [
        ["useradd -m -s /bin/bash -G grp user", "ユーザーを作成"],
        ["usermod -aG grp user", "既存ユーザーをグループに追加"],
        ["id user", "UID と所属グループ"],
        ["chgrp -R grp dir", "所有グループを変更"],
        ["chmod -R g+w dir", "グループに書き込みを許可"],
        ["chmod g+s dir", "setgid（グループを引き継ぐ）"],
        ["sudo -u user cmd", "別のユーザーとして実行"],
      ],
    },
  });

  /* ---------------------------------------------------------------- 4. a runaway process */
  const SCRIPT = "/opt/report/rebuild-index.sh";
  IG.registerMission({
    id: "basics-04",
    track: "basics",
    order: 4,
    difficulty: 2,
    par: 360,
    xp: 160,
    title: "CPU を食いつぶすプロセス",
    summary: "負荷の高いプロセスを突き止めて止め、cron からの再発を防ぐ",
    story: [
      "バッチサーバー batch-01 の監視が「CPU 使用率 100%・ロードアベレージ上昇」を通知しています。このままでは夜間の集計処理が間に合いません。",
      "どのプロセスが CPU を使っているのかを突き止めて止め、同じことが起きないようにしてください。スクリプト自体の修正は担当チームが後日行います。",
    ],
    cwd: HOME,
    setup(w, B) {
      const now = w.now();
      const run = (min, time) => ({
        user: "report",
        cmd: "/bin/bash " + SCRIPT,
        cpu: 66.4,
        mem: 0.1,
        stat: "R",
        time,
        at: now - min * 60e3,
      });
      w.addHost("batch-01", {
        user: "ubuntu",
        ip: "10.0.1.43",
        users: [{ name: "report", createHome: false }],
        procs: [run(14, "9:17"), run(9, "5:58"), run(4, "2:39")],
        files: {
          "/etc/cron.d/rebuild-index": IG.t(
            "# 検索インデックスの再構築（担当: report チーム）\n*/5 * * * * report /opt/report/rebuild-index.sh\n",
          ),
          [SCRIPT]: {
            content:
              "#!/bin/bash\n# Rebuild the search index once the nightly export is ready.\nuntil [ -f /var/lib/report/export.ready ]; do\n  :   # TODO: wait between checks\ndone\n/opt/report/bin/indexer --rebuild\n",
            mode: 0o755,
          },
        },
      });
      const h = host(w, "batch-01");
      const at = (min) => IG.strftime("%b %e %H:%M:%S", now - min * 60e3);
      h.appendLog(
        "/var/log/syslog",
        [14, 9, 4].map((m) => `${at(m)} batch-01 CRON[${4100 + m}]: (report) CMD (${SCRIPT})`),
      );
      B.files(w, {
        [HOME + "/tickets/ALERT-5521.txt"]: IG.t(
          "アラート: batch-01 CPU 使用率 100%（15 分継続）\n対象: batch-01 (10.0.1.43) / ユーザー ubuntu（sudo 可）\n接続: ssh batch-01\n依頼: 原因のプロセスを止め、再発しないようにする\n",
        ),
      });
    },
    objectives: [
      {
        title: "負荷の原因を見つける",
        detail: "CPU を使っているプロセスと、その実行ユーザーを調べる",
        hints: [
          "`uptime` でロードアベレージ、`top` で CPU を使っている順にプロセスが見られます。",
          "`ps aux --sort=-%cpu | head` で CPU 使用率の高い順に並べられます。USER 列と COMMAND 列に注目。",
        ],
        check: (w, c) => c.ran(/\b(top|htop|pidstat)\b|\bps\b.*(aux|-e|--sort)|\bpgrep\b/),
      },
      {
        title: "暴走したプロセスをすべて止める",
        detail: "同じスクリプトがいくつも動いている。すべて終了させる",
        hints: [
          "`pgrep -af rebuild-index` で、一致するプロセスの PID と引数を一覧できます。",
          "ほかのユーザー（report）のプロセスなので sudo が必要。`sudo pkill -f rebuild-index.sh` でまとめて止められます（PID を指定するなら `sudo kill <PID> ...`）。",
        ],
        check: (w) => !host(w, "batch-01").extraProcs.some((p) => p.cmd.includes("rebuild-index")),
      },
      {
        title: "cron からの再起動を止める",
        detail: "5 分ごとにスクリプトを起動している cron の設定を無効にする",
        hints: [
          "プロセスを止めても、5 分後にまた起動されます。`ls /etc/cron.d/` や `sudo crontab -u report -l`、`grep CRON /var/log/syslog` で起動元を探しましょう。",
          "`/etc/cron.d/rebuild-index` の行の先頭に # を付けてコメントアウトします: `sudo sed -i 's|^\\*/5|#*/5|' /etc/cron.d/rebuild-index`（エディタなら `sudo vi /etc/cron.d/rebuild-index`）。",
        ],
        check: (w) => {
          const h = host(w, "batch-01");
          const files = h.vfs.walk("/etc/cron.d").concat(["/etc/crontab", "/var/spool/cron/crontabs/report"]);
          return !files.some((p) => active(h.vfs.read(p)).some((l) => l.includes("rebuild-index")));
        },
      },
    ],
    solution: [
      "ssh batch-01",
      "uptime",
      "ps aux --sort=-%cpu | head -5",
      "pgrep -af rebuild-index",
      "sudo pkill -f rebuild-index.sh",
      "grep -r rebuild-index /etc/cron.d",
      "sudo sed -i 's|^\\*/5|#*/5|' /etc/cron.d/rebuild-index",
      "cat /etc/cron.d/rebuild-index",
      "uptime",
    ],
    debrief: {
      points: [
        "負荷の調査は uptime（ロードアベレージ）→ top / ps aux --sort=-%cpu（どのプロセスか）→ そのプロセスの起動元、の順に進める。",
        "pkill -f はコマンドライン全体が一致したプロセスをまとめて止める。止める前に pgrep -af で対象を必ず確かめる。ほかのユーザーのプロセスには sudo が必要。",
        "定期実行の起動元は /etc/cron.d/・/etc/crontab・crontab -u <ユーザー> -l・systemctl list-timers。プロセスを止めるだけでは次の実行でまた起動する。",
      ],
      commands: [
        ["uptime", "ロードアベレージ"],
        ["top", "CPU を使っている順"],
        ["ps aux --sort=-%cpu", "CPU 使用率順のプロセス一覧"],
        ["pgrep -af <名前>", "一致するプロセスと引数"],
        ["sudo pkill -f <パターン>", "一致するプロセスをまとめて終了"],
        ["crontab -u <user> -l", "ユーザーの cron を表示"],
      ],
    },
  });

  /* ---------------------------------------------------------------- 5. a new disk and fstab */
  IG.registerMission({
    id: "basics-05",
    track: "basics",
    order: 5,
    difficulty: 2,
    par: 420,
    xp: 170,
    title: "増設ディスクを使えるようにせよ",
    summary: "追加したディスクをフォーマットして /data にマウントし、再起動後も残るようにする",
    story: [
      "データベースのバックアップ置き場が足りなくなり、db-01 に 100 GiB のディスクを追加しました。",
      "ところが OS からはまだ使えません。ファイルシステムを作って /data にマウントし、再起動しても外れないように設定してください。",
      "ディスクを取り違えると既存のデータが消えます。作業の前に、どれが新しいディスクかを必ず確かめましょう。",
    ],
    cwd: HOME,
    setup(w, B) {
      w.addHost("db-01", {
        user: "ubuntu",
        ip: "10.0.1.42",
        osVersion: "24.04",
        disks: [{ name: "nvme1n1", sizeGiB: 100 }],
      });
      B.files(w, {
        [HOME + "/tickets/CHG-0412.txt"]: IG.t(
          "変更依頼: db-01 に追加したディスク（100 GiB）を /data として使えるようにする\n- ファイルシステム: ext4\n- マウント先: /data（再起動後も自動でマウントされること）\n- 接続: ssh db-01（ユーザー ubuntu・sudo 可）\n",
        ),
      });
    },
    objectives: [
      {
        title: "新しいディスクを見つける",
        detail: "lsblk などで、まだ使われていない 100 GiB のディスクを確かめる",
        hints: [
          "`lsblk` でディスクとパーティション、マウント先が一覧できます。",
          "パーティションもマウント先もない 100G の nvme1n1 が今回のディスクです。`sudo blkid` で既存のファイルシステムがないことも確かめられます。",
        ],
        check: (w, c) => c.ran(/\b(lsblk|blkid|lshw)\b|fdisk\s+-l|parted\s+(-l|\S+\s+print)/),
      },
      {
        title: "ext4 で /data にマウントする",
        detail: "ファイルシステムを作り、/data にマウントする",
        hints: [
          "`sudo mkfs.ext4 /dev/nvme1n1` でファイルシステムを作ります（パーティションを切ってからでも構いません）。",
          "`sudo mkdir -p /data` → `sudo mount /dev/nvme1n1 /data` → `df -h /data` で確認。",
        ],
        check: (w) => {
          const m = mountAt(host(w, "db-01"), "/data");
          return !!m && m.type === "ext4";
        },
      },
      {
        title: "再起動しても自動でマウントされるようにする",
        detail: "/etc/fstab に UUID で登録し、mount -a か再起動で確かめる",
        hints: [
          "デバイス名（/dev/nvme1n1）は起動のたびに変わることがあるので、fstab には UUID を書きます。`sudo blkid /dev/nvme1n1` で確認できます。",
          '`echo "UUID=$(sudo blkid -s UUID -o value /dev/nvme1n1) /data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab` で追記し、`sudo umount /data && sudo mount -a` で fstab から正しくマウントできるか確かめます。',
        ],
        check: (w, c) => {
          const h = host(w, "db-01");
          const m = mountAt(h, "/data");
          if (!m || !m.vol || !c.ranSince(1, /\bmount\s+-a\b|findmnt\s+--verify|\breboot\b|shutdown\s+-r/))
            return false;
          const id = m.vol.o.uuid;
          const names = [m.src, m.vol.dev, `UUID=${id}`, `UUID="${id}"`, `/dev/disk/by-uuid/${id}`];
          return active(h.vfs.read("/etc/fstab")).some((l) => {
            const f = l.split(/\s+/);
            return names.includes(f[0]) && f[1] === "/data";
          });
        },
      },
    ],
    solution: [
      "ssh db-01",
      "lsblk",
      "sudo blkid",
      "sudo mkfs.ext4 /dev/nvme1n1",
      "sudo mkdir -p /data",
      "sudo mount /dev/nvme1n1 /data",
      "df -h /data",
      'echo "UUID=$(sudo blkid -s UUID -o value /dev/nvme1n1) /data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab',
      "sudo umount /data",
      "sudo mount -a",
      "findmnt /data",
    ],
    debrief: {
      points: [
        "新しいディスクは lsblk で「パーティションもマウント先もない」ことを確かめてから mkfs する。取り違えると既存のデータが消える。",
        "fstab にはデバイス名ではなく UUID を書く（NVMe や仮想ディスクは起動ごとに名前が入れ替わることがある）。追加ディスクに nofail を付けると、ディスクが外れていても起動が止まらない。",
        "fstab を書いたら umount → mount -a（または findmnt --verify）で確かめてから再起動する。書き間違いは次の起動で emergency mode の原因になる。",
      ],
      commands: [
        ["lsblk", "ディスク・パーティション・マウント先"],
        ["sudo mkfs.ext4 /dev/<disk>", "ext4 を作成"],
        ["sudo mount <dev> <dir>", "マウント"],
        ["sudo blkid", "UUID とファイルシステムの種類"],
        ["sudo mount -a", "fstab の全行をマウント"],
        ["sudo findmnt --verify", "fstab の書式を検証"],
      ],
    },
  });

  /* ---------------------------------------------------------------- 6. a systemd unit */
  IG.registerMission({
    id: "basics-06",
    track: "basics",
    order: 6,
    difficulty: 2,
    par: 420,
    xp: 180,
    title: "再起動のあとアプリが戻らない",
    summary: "systemd のサービスが起動しない原因を直し、再起動後も自動で動くようにする",
    story: [
      "昨夜のカーネル更新で app-03 を再起動したところ、在庫 API（inventory）が止まったままになりました。",
      "前任者のメモには「新しいバイナリを置いてサービス化した。手で起動すれば動く」とだけあります。",
      "inventory.service が起動しない原因を直し、次に再起動しても自動で起動するようにしてください。",
    ],
    cwd: HOME,
    setup(w, B) {
      const boot = IG.strftime("%b %d %H:%M:%S", w.now() - 3 * 3600e3 + 21e3); // the reboot (uptimeDays: 0 = 3 hours ago)
      w.addHost("app-03", {
        user: "ubuntu",
        ip: "10.0.1.45",
        osVersion: "24.04",
        uptimeDays: 0,
        users: [{ name: "inventory", createHome: false, shell: "/usr/sbin/nologin" }],
        services: { inventory: "failed" },
        web: {
          port: 8080,
          service: "inventory",
          kind: "app",
          app: "inventory",
          version: "1.4.2",
          server: "inventory/1.4.2",
        },
        files: {
          "/etc/systemd/system/inventory.service":
            "[Unit]\nDescription=Inventory API\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nUser=inventory\nExecStart=/opt/inventory/bin/inventory-server --port 8080\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n",
          "/opt/inventory/bin/inventory-server": { content: "\x7fELF\x02\x01\x01", size: 23855104, mode: 0o644 },
          "/opt/inventory/README.txt": IG.t(
            "inventory 1.4.2 のバイナリを配置（2026-11-18）。起動: systemctl start inventory\n",
          ),
        },
        journal: {
          inventory: [
            `${boot} app-03 systemd[1]: inventory.service: Failed to execute /opt/inventory/bin/inventory-server: Permission denied`,
            `${boot} app-03 systemd[1]: inventory.service: Failed at step EXEC spawning /opt/inventory/bin/inventory-server: Permission denied`,
            `${boot} app-03 systemd[1]: inventory.service: Main process exited, code=exited, status=203/EXEC`,
            `${boot} app-03 systemd[1]: inventory.service: Failed with result 'exit-code'.`,
          ],
        },
      });
      host(w, "app-03").enabled.inventory = false;
      B.files(w, {
        [HOME + "/tickets/INC-2087.txt"]: IG.t(
          "件名: 在庫 API（http://app-03:8080/healthz）が応答しない\n発生: 2026-11-18 夜のカーネル更新・再起動の後から\n対象: app-03 (10.0.1.45) / ユーザー ubuntu（sudo 可）\n接続: ssh app-03\n",
        ),
      });
    },
    objectives: [
      {
        title: "起動しない理由を調べる",
        detail: "サービスの状態とログから、失敗の原因を確かめる",
        hints: [
          "`systemctl status inventory` で状態と直近のログが見られます。",
          "`sudo journalctl -u inventory` に「Permission denied」「203/EXEC」とあります。ExecStart に書かれたファイルの権限を `ls -l` で確かめましょう。",
        ],
        check: (w, c) => c.ran(/systemctl\s+status\s+inventory|journalctl\b.*inventory/),
      },
      {
        title: "inventory を起動する",
        detail: "原因を直して、サービスを起動する",
        hints: [
          "status=203/EXEC は「ExecStart のプログラムを実行できなかった」という意味です。実行権限（x）がありません。",
          "`sudo chmod +x /opt/inventory/bin/inventory-server` のあと `sudo systemctl restart inventory`。`systemctl status inventory` が active (running) になれば OK。",
        ],
        check: (w) => host(w, "app-03").svcState("inventory") === "active",
      },
      {
        title: "再起動しても自動で起動するようにする",
        detail: "サービスを有効化（enable）して、次の起動で立ち上がるようにする",
        hints: [
          "`systemctl is-enabled inventory` が disabled だと、再起動の後は起動しません。",
          "`sudo systemctl enable inventory`（起動もまとめてなら `sudo systemctl enable --now inventory`）。`sudo reboot` で本当に戻るか試せます。",
        ],
        check: (w) => {
          const h = host(w, "app-03");
          return h.enabled.inventory === true && !h.masked.has("inventory") && h.svcState("inventory") === "active";
        },
      },
      {
        title: "API の応答を確かめる",
        detail: "http://app-03:8080/healthz に 200 が返ることを確かめる",
        hints: ["踏み台に戻らなくても、app-03 の上から curl できます。", "`curl -s http://app-03:8080/healthz`"],
        check: (w, c) => c.http((r) => r.ok && r.port === 8080 && !!r.target && r.target.name === "app-03"),
      },
    ],
    solution: [
      "ssh app-03",
      "systemctl status inventory",
      "sudo journalctl -u inventory -n 20",
      "ls -l /opt/inventory/bin/",
      "sudo chmod +x /opt/inventory/bin/inventory-server",
      "sudo systemctl enable --now inventory",
      "systemctl status inventory",
      "curl -s http://app-03:8080/healthz",
    ],
    debrief: {
      points: [
        "サービスが動かないときは systemctl status → journalctl -u の順。status=203/EXEC は ExecStart のプログラムが無い・実行権限が無い・パスが違う、のどれか。",
        "start は「今だけ」、enable は「次の起動から」。両方なら systemctl enable --now。is-active と is-enabled で確かめられる。",
        "ユニットファイルを書き換えたら systemctl daemon-reload。再起動で本当に戻るかは、メンテナンスの時間内に一度試しておくと安心。",
      ],
      commands: [
        ["systemctl status <unit>", "状態と直近のログ"],
        ["journalctl -u <unit>", "ユニットのログ"],
        ["chmod +x <file>", "実行権限を付ける"],
        ["systemctl enable --now <unit>", "有効化して今すぐ起動"],
        ["systemctl is-enabled <unit>", "自動起動の設定"],
        ["systemctl daemon-reload", "ユニットファイルを読み直す"],
      ],
    },
  });

  /* ---------------------------------------------------------------- 7. firewalld */
  IG.registerMission({
    id: "basics-07",
    track: "basics",
    order: 7,
    difficulty: 3,
    par: 420,
    xp: 200,
    title: "サーバーの中では動くのに",
    summary: "RHEL の firewalld でポートを開け、再起動しても消えない設定にする",
    story: [
      "注文 API（orders-api）を新しい RHEL 9 サーバー app-04 に移しました。サーバーの中で curl すると応答があるのに、踏み台やほかのサーバーからは繋がりません。",
      "アプリが正しく待ち受けていることを確かめたうえで、通信を止めているものを突き止め、再起動しても元に戻らない形で直してください。",
    ],
    cwd: HOME,
    setup(w, B) {
      w.addHost("app-04", {
        os: "rhel",
        user: "ec2-user",
        ip: "10.0.1.47",
        services: { "orders-api": "active" },
        web: {
          port: 8080,
          service: "orders-api",
          kind: "app",
          app: "orders-api",
          version: "3.2.0",
          server: "orders-api/3.2.0",
        },
        files: {
          "/etc/systemd/system/orders-api.service":
            "[Unit]\nDescription=Orders API\nAfter=network-online.target\n\n[Service]\nExecStart=/opt/orders/bin/orders-api --listen 0.0.0.0:8080\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n",
          "/opt/orders/bin/orders-api": { content: "\x7fELF\x02\x01\x01", size: 31457280, mode: 0o755 },
        },
      });
      B.files(w, {
        [HOME + "/tickets/INC-2093.txt"]: IG.t(
          "件名: 注文 API（http://app-04:8080/）に接続できない\n対象: app-04 (10.0.1.47) / ユーザー ec2-user（sudo 可）\n接続: ssh app-04\n備考: サーバーの上で curl localhost:8080 を実行すると応答がある\n",
        ),
      });
    },
    objectives: [
      {
        title: "アプリが待ち受けているか確かめる",
        detail: "app-04 の上で、8080 番ポートを待ち受けているプロセスを確認する",
        hints: [
          "`ssh app-04` してから `sudo ss -tlnp` で、待ち受け中のポートとプロセスが見られます。",
          "0.0.0.0:8080 で orders-api が待ち受けていて、`curl -s localhost:8080` も成功します。アプリは正常。では外からの通信を止めているのは？",
        ],
        check: (w, c) => c.ran(/\bss\s+-\w*l|\bnetstat\s+-\w*l|\blsof\s+-i|curl\b.*(localhost|127\.0\.0\.1):8080/),
      },
      {
        title: "8080/tcp を開ける",
        detail: "firewalld で 8080/tcp を許可する（今すぐ有効になること）",
        hints: [
          "RHEL ではファイアウォール（firewalld）が既定で動いています。`sudo firewall-cmd --list-all` で、許可されている services と ports を確かめましょう。",
          "`sudo firewall-cmd --add-port=8080/tcp` で今すぐ許可されます。",
        ],
        check: (w) => host(w, "app-04").firewall.firewalld.ports.includes("8080/tcp"),
      },
      {
        title: "再起動しても消えないようにする",
        detail: "同じ許可を恒久設定（--permanent）にも入れる",
        hints: [
          "--permanent を付けない変更は、`firewall-cmd --reload` や再起動で消えます。",
          "`sudo firewall-cmd --runtime-to-permanent`（または `sudo firewall-cmd --permanent --add-port=8080/tcp` → `sudo firewall-cmd --reload`）。`sudo firewall-cmd --permanent --list-ports` で確認。",
        ],
        check: (w) => {
          const fw = host(w, "app-04").firewall.firewalld;
          return fw.ports.includes("8080/tcp") && !!fw.perm && fw.perm.ports.includes("8080/tcp");
        },
      },
      {
        title: "踏み台から確かめる",
        detail: "踏み台から http://app-04:8080/ に 200 が返ることを確かめる",
        hints: ["`exit` で踏み台に戻ります。", "`curl -s http://app-04:8080/`"],
        check: (w, c) =>
          c.http((r) => r.ok && r.port === 8080 && !!r.target && r.target.name === "app-04" && r.src === "bastion"),
      },
    ],
    solution: [
      "curl -s -m 5 http://app-04:8080/",
      "ssh app-04",
      "sudo ss -tlnp",
      "curl -s localhost:8080",
      "sudo firewall-cmd --list-all",
      "sudo firewall-cmd --permanent --add-port=8080/tcp",
      "sudo firewall-cmd --reload",
      "sudo firewall-cmd --list-ports",
      "exit",
      "curl -s http://app-04:8080/",
    ],
    debrief: {
      points: [
        "「中からは繋がるのに外からは繋がらない」はファイアウォールを疑う典型。firewalld は拒否を ICMP で返すので curl は No route to host、クラウドのセキュリティグループや ufw は黙って捨てるのでタイムアウトになる。",
        "firewall-cmd の変更は既定で「今だけ」（runtime）。--permanent は「次から」で、--reload するまで効かない。両方そろえるには --permanent + --reload か --runtime-to-permanent。",
        "開けるポートは必要な分だけ。クラウドでは、セキュリティグループと OS のファイアウォールの二段構えになっていることが多い。",
      ],
      commands: [
        ["sudo ss -tlnp", "待ち受け中の TCP ポートとプロセス"],
        ["sudo firewall-cmd --list-all", "許可中のサービスとポート"],
        ["sudo firewall-cmd --permanent --add-port=8080/tcp", "恒久設定にポートを追加"],
        ["sudo firewall-cmd --reload", "恒久設定を読み込み直す"],
        ["sudo firewall-cmd --runtime-to-permanent", "今の設定を恒久設定に保存"],
        ["curl -m 5 <URL>", "5 秒で打ち切る"],
      ],
    },
  });

  /* ---------------------------------------------------------------- 8. growing an LVM volume */
  const PGDATA = "/var/lib/pgsql";
  IG.registerMission({
    id: "basics-08",
    track: "basics",
    order: 8,
    difficulty: 3,
    par: 540,
    xp: 220,
    title: "データベースの容量が足りない",
    summary: "LVM にディスクを足し、論理ボリュームとファイルシステムを止めずに広げる",
    story: [
      "db-02（RHEL 9）の PostgreSQL が「No space left on device」で止まりました。データ領域 /var/lib/pgsql の使用率は 97% です。",
      "インフラチームが 10 GiB のディスクを追加済みです。データ領域は LVM の論理ボリュームなので、ボリュームグループにこのディスクを足せば、アンマウントせずに広げられます。",
      "/var/lib/pgsql を広げて、PostgreSQL を再開してください。",
    ],
    cwd: HOME,
    setup(w, B) {
      const t = w.now() - 25 * 60e3;
      const at = IG.strftime("%b %d %H:%M:%S", t);
      const pgAt = IG.strftime("%F %T", t) + ".512 UTC";
      w.addHost("db-02", {
        os: "rhel",
        user: "ec2-user",
        ip: "10.0.1.46",
        disks: [
          { name: "nvme1n1", sizeGiB: 8 },
          { name: "nvme2n1", sizeGiB: 10 },
        ],
        users: [{ name: "postgres", home: PGDATA, createHome: false }],
        services: { postgresql: "failed" },
        journal: {
          postgresql: [
            `${at} db-02 postmaster[2412]: ${pgAt} [2412] PANIC:  could not write to file "pg_wal/xlogtemp.2412": No space left on device`,
            `${at} db-02 systemd[1]: postgresql.service: Main process exited, code=exited, status=1/FAILURE`,
            `${at} db-02 systemd[1]: postgresql.service: Failed with result 'exit-code'.`,
          ],
        },
        checks: {
          postgresql: (h) => {
            const m = mountAt(h, PGDATA);
            return m && m.used / m.size > 0.95
              ? ['PANIC:  could not write to file "pg_wal/xlogtemp.2412": No space left on device']
              : null;
          },
        },
      });
      prepare(w, "db-02", [
        "sudo pvcreate /dev/nvme1n1",
        "sudo vgcreate datavg /dev/nvme1n1",
        "sudo lvcreate -n pgdata -l 100%FREE datavg",
        "sudo mkfs.xfs /dev/datavg/pgdata",
        "sudo mkdir -p " + PGDATA,
        `sudo mount /dev/datavg/pgdata ${PGDATA}`,
        `echo '/dev/mapper/datavg-pgdata ${PGDATA} xfs defaults 0 0' | sudo tee -a /etc/fstab`,
        `sudo chown postgres:postgres ${PGDATA}`,
      ]);
      const h = host(w, "db-02");
      const pg = { owner: "postgres", group: "postgres", mkdirs: true };
      h.vfs.write(PGDATA + "/data/base/16384/2613", "", Object.assign({ size: 7.62 * 1073741824 }, pg));
      h.vfs.write(PGDATA + "/data/PG_VERSION", "16\n", pg);
      B.files(w, {
        [HOME + "/tickets/INC-2101.txt"]: IG.t(
          "件名: db-02 の PostgreSQL が停止（No space left on device）\n対象: db-02 (10.0.1.46) / ユーザー ec2-user（sudo 可）\n接続: ssh db-02\n備考: 10 GiB のディスク（nvme2n1）を追加済み。データ領域は LVM（datavg/pgdata）\n",
        ),
      });
    },
    objectives: [
      {
        title: "空き容量と構成を調べる",
        detail: "どの論理ボリュームが満杯か、ボリュームグループに空きがあるかを確かめる",
        hints: [
          "`df -h /var/lib/pgsql` で使用率、`lsblk` でディスクと LVM の関係が見られます。",
          "`sudo vgs` で datavg の VFree が 0。`lsblk` には使われていない nvme2n1（10G）があります。",
        ],
        check: (w, c) => c.ran(/\bdf\b/) && c.ran(/\b(vgs|vgdisplay|lvs|lvdisplay|pvs|pvdisplay|lsblk)\b/),
      },
      {
        title: "ボリュームグループにディスクを足す",
        detail: "新しいディスクを物理ボリュームにして、datavg に加える",
        hints: [
          "`sudo pvcreate /dev/nvme2n1` でディスクを LVM の物理ボリューム（PV）にします。",
          "`sudo vgextend datavg /dev/nvme2n1` でボリュームグループに加え、`sudo vgs` で VFree が増えたことを確認。",
        ],
        check: (w) => {
          const pv = IG.storageState(host(w, "db-02")).pvs["/dev/nvme2n1"];
          return !!pv && pv.vg === "datavg";
        },
      },
      {
        title: "/var/lib/pgsql を広げる",
        detail: "論理ボリュームとファイルシステムを広げ、使用率を 80% 未満にする",
        hints: [
          "lvextend に -r を付けると、ファイルシステム（XFS なら xfs_growfs）の拡張まで一度に行えます。",
          "`sudo lvextend -r -l +100%FREE /dev/datavg/pgdata` のあと `df -h /var/lib/pgsql`。",
        ],
        check: (w) => {
          const m = mountAt(host(w, "db-02"), PGDATA);
          return !!m && m.used / m.size < 0.8;
        },
      },
      {
        title: "PostgreSQL を再開する",
        detail: "postgresql サービスを起動し、active になったことを確かめる",
        hints: [
          "`sudo systemctl start postgresql`（容量が足りないままだと、また失敗します）。",
          "`systemctl status postgresql` で active (running) を確認。",
        ],
        check: (w) => host(w, "db-02").svcState("postgresql") === "active",
      },
    ],
    solution: [
      "ssh db-02",
      "df -h /var/lib/pgsql",
      "lsblk",
      "sudo vgs",
      "sudo pvcreate /dev/nvme2n1",
      "sudo vgextend datavg /dev/nvme2n1",
      "sudo lvextend -r -l +100%FREE /dev/datavg/pgdata",
      "df -h /var/lib/pgsql",
      "sudo systemctl start postgresql",
      "systemctl status postgresql",
    ],
    debrief: {
      points: [
        "LVM なら「PV を作る（pvcreate）→ VG に足す（vgextend）→ LV を広げる（lvextend）」で、アンマウントせずに容量を増やせる。",
        "lvextend -r はファイルシステムの拡張（xfs_growfs / resize2fs）まで行う。-r を忘れると LV だけが大きくなり、df の値は変わらない。XFS は広げられるが縮められない。",
        "容量不足で止まったサービスは、空きを作ってから起動し直す。再発を防ぐには使用率の監視（80% で警告など）を入れておく。",
      ],
      commands: [
        ["df -h <dir>", "使用率"],
        ["sudo vgs / lvs / pvs", "LVM の一覧"],
        ["sudo pvcreate /dev/<disk>", "物理ボリュームを作成"],
        ["sudo vgextend <vg> /dev/<disk>", "VG にディスクを追加"],
        ["sudo lvextend -r -l +100%FREE <lv>", "LV と FS を空き全部まで拡張"],
        ["xfs_growfs / resize2fs", "ファイルシステムだけを拡張"],
      ],
    },
  });
})((globalThis.IG = globalThis.IG || {}));

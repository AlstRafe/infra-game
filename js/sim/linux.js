/* Linux host model: OS base filesystem, accounts, systemd services, processes, packages,
 * listening sockets, firewall and permission checks. One Host per simulated machine. */
(function (IG) {
  "use strict";
  const U = IG.util;
  const VFS = IG.VFS;

  /* ------------------------------------------------------------ service catalog */
  const SVC = {
    "ssh": {
      desc: "OpenBSD Secure Shell server",
      exec: "/usr/sbin/sshd -D",
      proc: "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups",
      ports: [{ port: 22 }],
      pkg: "openssh-server",
      unit: "ssh",
      alias: ["sshd"],
    },
    "sshd": {
      desc: "OpenSSH server daemon",
      exec: "/usr/sbin/sshd -D",
      proc: "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups",
      ports: [{ port: 22 }],
      pkg: "openssh-server",
    },
    "cron": {
      desc: "Regular background program processing daemon",
      exec: "/usr/sbin/cron -f -P",
      proc: "/usr/sbin/cron -f -P",
      pkg: "cron",
    },
    "crond": { desc: "Command Scheduler", exec: "/usr/sbin/crond -n", proc: "/usr/sbin/crond -n", pkg: "cronie" },
    "rsyslog": {
      desc: "System Logging Service",
      exec: "/usr/sbin/rsyslogd -n -iNONE",
      proc: "/usr/sbin/rsyslogd -n -iNONE",
      user: "syslog",
      pkg: "rsyslog",
    },
    "systemd-journald": {
      desc: "Journal Service",
      exec: "/lib/systemd/systemd-journald",
      proc: "/lib/systemd/systemd-journald",
      static: true,
    },
    "systemd-resolved": {
      desc: "Network Name Resolution",
      exec: "/lib/systemd/systemd-resolved",
      proc: "/lib/systemd/systemd-resolved",
      user: "systemd-resolve",
      ports: [
        { port: 53, addr: "127.0.0.53", proto: "udp" },
        { port: 53, addr: "127.0.0.53" },
      ],
    },
    "systemd-timesyncd": {
      desc: "Network Time Synchronization",
      exec: "/lib/systemd/systemd-timesyncd",
      proc: "/lib/systemd/systemd-timesyncd",
      user: "systemd-timesync",
    },
    "chronyd": {
      desc: "NTP client/server",
      exec: "/usr/sbin/chronyd -F 2",
      proc: "/usr/sbin/chronyd -F 2",
      user: "chrony",
      ports: [{ port: 323, addr: "127.0.0.1", proto: "udp" }],
      pkg: "chrony",
    },
    "NetworkManager": {
      desc: "Network Manager",
      exec: "/usr/sbin/NetworkManager --no-daemon",
      proc: "/usr/sbin/NetworkManager --no-daemon",
    },
    "firewalld": {
      desc: "firewalld - dynamic firewall daemon",
      exec: "/usr/bin/python3 -s /usr/sbin/firewalld --nofork --nopid",
      proc: "/usr/bin/python3 -s /usr/sbin/firewalld --nofork --nopid",
      pkg: "firewalld",
    },
    "nginx": {
      desc: "A high performance web server and a reverse proxy server",
      exec: "/usr/sbin/nginx -g daemon on; master_process on;",
      proc: "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;",
      workers: { user: "www-data", cmd: "nginx: worker process", n: 2 },
      ports: [{ port: 80 }],
      pkg: "nginx",
      reload: true,
      web: "nginx",
    },
    "apache2": {
      desc: "The Apache HTTP Server",
      exec: "/usr/sbin/apachectl start",
      proc: "/usr/sbin/apache2 -k start",
      workers: { user: "www-data", cmd: "/usr/sbin/apache2 -k start", n: 2 },
      ports: [{ port: 80 }],
      pkg: "apache2",
      reload: true,
      web: "apache",
    },
    "httpd": {
      desc: "The Apache HTTP Server",
      exec: "/usr/sbin/httpd -DFOREGROUND",
      proc: "/usr/sbin/httpd -DFOREGROUND",
      workers: { user: "apache", cmd: "/usr/sbin/httpd -DFOREGROUND", n: 3 },
      ports: [{ port: 80 }],
      pkg: "httpd",
      reload: true,
      web: "apache",
    },
    "docker": {
      desc: "Docker Application Container Engine",
      exec: "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock",
      proc: "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock",
      pkg: "docker-ce",
      restart: true,
    },
    "containerd": {
      desc: "containerd container runtime",
      exec: "/usr/bin/containerd",
      proc: "/usr/bin/containerd",
      pkg: "containerd.io",
      restart: true,
    },
    "kubelet": {
      desc: "kubelet: The Kubernetes Node Agent",
      exec: "/usr/bin/kubelet --config=/var/lib/kubelet/config.yaml --kubeconfig=/etc/kubernetes/kubelet.conf",
      proc: "/usr/bin/kubelet --config=/var/lib/kubelet/config.yaml --kubeconfig=/etc/kubernetes/kubelet.conf --container-runtime-endpoint=unix:///run/containerd/containerd.sock",
      ports: [{ port: 10250 }, { port: 10248, addr: "127.0.0.1" }],
      pkg: "kubelet",
      restart: true,
    },
    "crio": {
      desc: "Container Runtime Interface for OCI (CRI-O)",
      exec: "/usr/bin/crio",
      proc: "/usr/bin/crio",
      pkg: "cri-o",
      restart: true,
    },
    "postgresql": {
      desc: "PostgreSQL RDBMS",
      exec: "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main",
      proc: "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf",
      user: "postgres",
      ports: [{ port: 5432, addr: "127.0.0.1" }],
      pkg: "postgresql",
      // RHEL's postgresql-server keeps its data in /var/lib/pgsql
      rhel: { exec: "/usr/bin/postmaster -D /var/lib/pgsql/data", proc: "/usr/bin/postmaster -D /var/lib/pgsql/data" },
    },
    "redis-server": {
      desc: "Advanced key-value store",
      exec: "/usr/bin/redis-server 127.0.0.1:6379",
      proc: "/usr/bin/redis-server 127.0.0.1:6379",
      user: "redis",
      ports: [{ port: 6379, addr: "127.0.0.1" }],
      pkg: "redis-server",
    },
    "ufw": { desc: "Uncomplicated firewall", exec: "/lib/ufw/ufw-init start quiet", oneshot: true, pkg: "ufw" },
  };

  /* ------------------------------------------------------------ packages (command → package) */
  const UBUNTU_BASE = [
    "bash",
    "coreutils",
    "grep",
    "sed",
    "gawk",
    "findutils",
    "tar",
    "gzip",
    "procps",
    "psmisc",
    "util-linux",
    "iproute2",
    "iputils-ping",
    "iputils-tracepath",
    "bind9-dnsutils",
    "curl",
    "wget",
    "openssh-client",
    "openssh-server",
    "rsync",
    "netcat-openbsd",
    "telnet",
    "systemd",
    "cron",
    "sudo",
    "passwd",
    "login",
    "less",
    "vim",
    "nano",
    "file",
    "lsof",
    "ufw",
    "iptables",
    "apt",
    "dpkg",
    "diffutils",
    "bc",
    "rsyslog",
    "logrotate",
    "tcpdump",
    "lvm2",
    "e2fsprogs",
    "parted",
    "cloud-guest-utils",
    "python3",
    "perl-base",
    "tmux",
    "xxd",
    "bsdextrautils",
    "pciutils",
    "usbutils",
    "dmidecode",
    "ethtool",
    "mtr-tiny",
    "openssl",
    "netplan.io",
    "systemd-resolved",
    "systemd-networkd",
    "zstd",
    "locales",
    "ca-certificates",
    "tzdata",
    "hostname",
    "xz-utils",
    "cloud-init",
    "git",
  ];
  const RHEL_BASE = [
    "bash",
    "coreutils",
    "grep",
    "sed",
    "gawk",
    "findutils",
    "tar",
    "gzip",
    "procps-ng",
    "psmisc",
    "util-linux",
    "iproute",
    "iputils",
    "bind-utils",
    "curl",
    "wget",
    "openssh-clients",
    "openssh-server",
    "rsync",
    "systemd",
    "cronie",
    "sudo",
    "passwd",
    "shadow-utils",
    "less",
    "vim-minimal",
    "nano",
    "file",
    "lsof",
    "firewalld",
    "iptables-nft",
    "dnf",
    "rpm",
    "diffutils",
    "bc",
    "rsyslog",
    "logrotate",
    "lvm2",
    "xfsprogs",
    "e2fsprogs",
    "parted",
    "cloud-utils-growpart",
    "acl",
    "pciutils",
    "dmidecode",
    "ethtool",
    "openssl",
    "systemd-coredump",
    "python3",
    "chrony",
    "NetworkManager",
    "hostname",
    "tcpdump",
    "git",
  ];
  const PKG = {
    "coreutils":
      "ls cp mv rm mkdir rmdir touch cat tac head tail wc sort uniq cut paste tr rev nl fold seq yes tee basename dirname realpath readlink stat chmod chown chgrp ln du df date sleep env printenv echo printf whoami id groups uname nproc mktemp truncate dd md5sum sha1sum sha256sum sha384sum sha512sum cksum base64 comm join split shuf expr test [ true false users who timeout nice nohup pwd install sync od fmt numfmt factor unexpand tty logname hostid link unlink mkfifo shred stty",
    "bash": "bash sh",
    "grep": "grep egrep fgrep",
    "sed": "sed",
    "gawk": "awk gawk",
    "findutils": "find xargs",
    "tar": "tar",
    "gzip": "gzip gunzip zcat",
    "procps": "ps top free kill pgrep pkill uptime vmstat watch sysctl w pidof pmap",
    "procps-ng": "ps top free kill pgrep pkill uptime vmstat watch sysctl w pidof pmap",
    "psmisc": "killall pstree fuser",
    "util-linux":
      "lsblk mount umount findmnt fdisk blkid dmesg su more column logger swapon swapoff mkswap wipefs partx fsck mkfs lscpu hwclock last lastb whereis ionice taskset chrt nsenter unshare wall mesg script hexdump",
    "iproute2": "ip ss",
    "iproute": "ip ss",
    "iputils-ping": "ping",
    "iputils": "ping tracepath",
    "iputils-tracepath": "tracepath",
    "bind9-dnsutils": "dig nslookup host",
    "bind-utils": "dig nslookup host",
    "curl": "curl",
    "wget": "wget",
    "openssh-client": "ssh scp sftp ssh-keygen ssh-copy-id ssh-keyscan ssh-agent ssh-add",
    "openssh-clients": "ssh scp sftp ssh-keygen ssh-copy-id ssh-keyscan ssh-agent ssh-add",
    "rsync": "rsync",
    "netcat-openbsd": "nc netcat",
    "nmap-ncat": "nc ncat",
    "telnet": "telnet",
    "systemd":
      "systemctl journalctl hostnamectl timedatectl localectl loginctl systemd-analyze systemd-run systemd-tmpfiles systemd-cgls",
    "cron": "crontab",
    "cronie": "crontab",
    "sudo": "sudo sudoedit visudo",
    "passwd": "passwd useradd usermod userdel groupadd groupdel chpasswd chage chsh chfn",
    "shadow-utils": "useradd usermod userdel groupadd groupdel chpasswd chage",
    "login": "login",
    "less": "less",
    "vim": "vi vim view",
    "vim-minimal": "vi",
    "nano": "nano",
    "file": "file",
    "lsof": "lsof",
    "ufw": "ufw",
    "iptables": "iptables",
    "iptables-nft": "iptables",
    "firewalld": "firewall-cmd",
    "apt": "apt apt-get apt-cache",
    "dpkg": "dpkg",
    "dnf": "dnf yum",
    "rpm": "rpm",
    "diffutils": "diff cmp",
    "bc": "bc",
    "logrotate": "logrotate",
    "tcpdump": "tcpdump",
    "lvm2":
      "pvs vgs lvs pvdisplay vgdisplay lvdisplay pvcreate pvremove vgcreate vgextend vgreduce vgremove lvcreate lvextend lvreduce lvresize lvremove lvrename",
    "e2fsprogs": "mkfs.ext4 mkfs.ext3 mkfs.ext2 mke2fs e2fsck fsck.ext4 resize2fs e2label",
    "xfsprogs": "mkfs.xfs xfs_info xfs_growfs xfs_repair fsck.xfs",
    "parted": "parted partprobe",
    "cloud-guest-utils": "growpart",
    "cloud-utils-growpart": "growpart",
    "acl": "setfacl getfacl",
    "perl-base": "perl",
    "nodejs": "node nodejs",
    "xxd": "xxd",
    "vim-common": "xxd",
    "bsdextrautils": "hexdump hd",
    "pciutils": "lspci",
    "usbutils": "lsusb",
    "dmidecode": "dmidecode",
    "binutils": "strings",
    "ethtool": "ethtool",
    "mtr-tiny": "mtr",
    "mtr": "mtr",
    "iputils-arping": "arping",
    "whois": "whois",
    "at": "at atq atrm batch",
    "openssl": "openssl",
    "network-manager": "nmcli",
    "NetworkManager": "nmcli",
    "netplan.io": "netplan",
    "systemd-resolved": "resolvectl",
    "systemd-networkd": "networkctl",
    "systemd-coredump": "coredumpctl",
    "util-linux-user": "chsh chfn",
    "zstd": "zstd unzstd zstdcat",
    "locales": "locale-gen update-locale",
    "glibc-langpack-ja": "",
    "build-essential": "gcc cc g++ make",
    "gcc": "gcc cc",
    "make": "make",
    "socat": "socat",
    "iperf3": "iperf3",
    "cpio": "cpio",
    "python3": "python3",
    "hostname": "hostname",
    "xz-utils": "xz unxz",
    "git": "git",
    "net-tools": "netstat ifconfig route arp",
    "traceroute": "traceroute",
    "htop": "htop",
    "sysstat": "iostat sar mpstat pidstat",
    "nmap": "nmap",
    "zip": "zip",
    "unzip": "unzip",
    "jq": "jq",
    "tree": "tree",
    "tmux": "tmux",
    "screen": "screen",
    "nginx": "nginx",
    "apache2": "apache2ctl apachectl a2ensite a2dissite a2enmod a2dismod a2enconf a2disconf",
    "httpd": "httpd apachectl",
    "redis-server": "redis-cli redis-server",
    "postgresql": "psql",
    "docker-ce": "docker",
    "containerd.io": "ctr",
    "kubelet": "kubelet",
    "cri-tools": "crictl",
    "cri-o": "crio",
    "kubectl": "kubectl",
    "openshift-clients": "oc",
    "awscli": "aws",
    "harbor-cli": "harbor",
    "chrony": "chronyc",
    "mysql-client": "mysql",
    "dnsmasq": "dnsmasq",
    "strace": "strace",
  };
  const CMD_PKG = {}; // command -> first (Debian-style) package that provides it (for suggestions)
  const CMD_PKGS = {}; // command -> every package that provides it (for "is it installed?")
  for (const [p, cmds] of Object.entries(PKG))
    for (const c of cmds.split(" ")) {
      if (!(c in CMD_PKG)) CMD_PKG[c] = p;
      (CMD_PKGS[c] = CMD_PKGS[c] || []).push(p);
    }
  CMD_PKG.tracepath = "iputils-tracepath";
  const PKG_VER = {
    "nginx": "1.24.0-2ubuntu7.1",
    "net-tools": "2.10-0.1ubuntu4",
    "traceroute": "1:2.1.5-1",
    "htop": "3.3.0-4build1",
    "sysstat": "12.6.1-2",
    "nmap": "7.94+git20230807.3be01efb1+dfsg-3build2",
    "acl": "2.3.1-1",
    "at": "3.2.5-1ubuntu1",
    "binutils": "2.38-4ubuntu2.6",
    "whois": "5.5.13",
    "iputils-arping": "3:20211215-1",
    "network-manager": "1.36.6-0ubuntu2",
    "build-essential": "12.9ubuntu3",
    "socat": "1.7.4.1-3ubuntu4",
    "iperf3": "3.9-1",
    "xfsprogs": "5.13.0-1ubuntu2.1",
    "glibc-langpack-ja": "2.34-100.el9",
    "zip": "3.0-13build1",
    "unzip": "6.0-28ubuntu4",
    "jq": "1.7.1-3build1",
    "tree": "2.1.1-2ubuntu3",
    "apache2": "2.4.58-1ubuntu8.4",
    "redis-server": "5:7.0.15-1build2",
    "postgresql": "16+257build1",
    "tmux": "3.4-1build1",
    "strace": "6.8-0ubuntu2",
    "mysql-client": "8.0.39-0ubuntu0.24.04.2",
  };
  const SERVICE_OF_PKG = {
    "nginx": "nginx",
    "apache2": "apache2",
    "httpd": "httpd",
    "redis-server": "redis-server",
    "postgresql": "postgresql",
    "openssh-server": "ssh",
  };

  /* ------------------------------------------------------------ host */
  let pidSeed = 900;
  class Host {
    constructor(name, spec = {}, world = null) {
      this.world = world;
      this.name = name;
      this.os = spec.os || "ubuntu";
      this.osPretty =
        spec.osPretty ||
        (this.os === "rhel"
          ? "Red Hat Enterprise Linux 9.4 (Plow)"
          : spec.osVersion === "24.04"
            ? "Ubuntu 24.04.1 LTS"
            : "Ubuntu 22.04.4 LTS");
      this.kernel =
        this.os === "rhel"
          ? "5.14.0-427.13.1.el9_4.x86_64"
          : this.osPretty.includes("24.04")
            ? "6.8.0-1016-aws"
            : "5.15.0-1066-aws";
      this.user = spec.user || "operator";
      this.home = spec.home || (this.user === "root" ? "/root" : "/home/" + this.user);
      this.ip = spec.ip || "10.0.1.20";
      this.publicIp = spec.publicIp || null;
      this.mac = "0a:" + U.hex(name, 10).match(/../g).join(":");
      this.cpus = spec.cpus || 2;
      this.memMiB = spec.memMiB || 7900;
      this.diskGiB = spec.diskGiB || 50;
      this.baseUsedGiB = spec.baseUsedGiB || 12;
      this.motd = spec.motd || "";
      this.journal = spec.journal || {};
      this.checks = spec.checks || {};
      this.web = spec.web || null;
      this.sshable = spec.sshable !== false;
      this.bootAt = (world ? world.now() : Date.now()) - (spec.uptimeDays || 12) * 86400e3 - 3 * 3600e3;
      this.pkgs = new Set((this.os === "rhel" ? RHEL_BASE : UBUNTU_BASE).concat(spec.pkgs || []));
      this.users = {};
      this.groups = {};
      this.firewall = {
        ufw: { enabled: false, rules: [] },
        firewalld: { ports: [], services: ["ssh", "dhcpv6-client", "cockpit"] },
        iptables: [],
      };
      this.sysctl = {
        "net.ipv4.ip_forward": "0",
        "vm.swappiness": "60",
        "fs.file-max": "9223372036854775807",
        "net.core.somaxconn": "4096",
        "kernel.hostname": name,
        "net.ipv4.tcp_syncookies": "1",
      };
      this.extraProcs = (spec.procs || []).map((p) =>
        Object.assign({ pid: ++pidSeed + 3000, user: "root", cpu: 0.1, mem: 0.2, stat: "S" }, p),
      );
      this.pids = {};
      this.listen = spec.listen || [];
      // extra block devices (e.g. an unformatted EBS volume) for mkfs / mount / fstab practice
      this.disks = (spec.disks || []).map((d) => Object.assign({ fs: null, mount: null, uuid: null }, d));
      this.lastLogins = [];
      this.enabled = {};
      this.masked = new Set();
      this.services = {};
      const base =
        this.os === "rhel"
          ? ["sshd", "crond", "rsyslog", "systemd-journald", "chronyd", "NetworkManager", "firewalld"]
          : ["ssh", "cron", "rsyslog", "systemd-journald", "systemd-resolved", "systemd-timesyncd"];
      for (const s of base) this.services[s] = "active";
      for (const [s, st] of Object.entries(spec.services || {})) {
        const n = this.os === "ubuntu" && s === "sshd" ? "ssh" : s;
        this.services[n] = st;
        const def = SVC[n];
        if (def && def.pkg) this.pkgs.add(def.pkg);
      }
      for (const s of Object.keys(this.services)) {
        this.enabled[s] = true;
        this.pids[s] = ++pidSeed;
      }
      for (const p of this.pkgs) for (const c of (PKG[p] || "").split(" ")) void c;
      this.vfs = new VFS({
        ownerFor: (p) => this.ownerFor(p),
        clock: () => (world ? world.now() : Date.now()) - 30 * 86400e3,
      });
      this.initAccounts(spec);
      this.seedFs(spec);
      this.systemdFstab = world ? world.now() : Date.now(); // fstab as last loaded by systemd (mount's daemon-reload hint)
      this.vfs.clock = () => (world ? world.now() : Date.now());
      for (const [p, c] of Object.entries(spec.files || {})) {
        const opt = typeof c === "string" ? {} : c;
        this.vfs.write(p, typeof c === "string" ? c : c.content || "", Object.assign({ mkdirs: true }, opt));
      }
      for (const d of spec.dirs || []) this.vfs.mkdirp(d);
    }
    get hostname() {
      return this.name;
    }
    ownerFor(p) {
      const m = p.match(/^\/home\/([^/]+)/);
      if (m && this.users && this.users[m[1]]) return [m[1], this.primaryGroup(m[1])];
      if (p.startsWith("/var/log/nginx")) return ["www-data", "adm"];
      if (p.startsWith("/var/www")) return ["root", "root"];
      return ["root", "root"];
    }
    primaryGroup(u) {
      const x = this.users[u];
      if (!x) return u;
      return Object.keys(this.groups).find((g) => this.groups[g].gid === x.gid) || u;
    }

    /* ---------------- accounts */
    initAccounts(spec) {
      const sys =
        this.os === "rhel"
          ? [
              ["root", 0, 0, "/root", "/bin/bash"],
              ["bin", 1, 1, "/bin", "/sbin/nologin"],
              ["daemon", 2, 2, "/sbin", "/sbin/nologin"],
              ["adm", 3, 4, "/var/adm", "/sbin/nologin"],
              ["nobody", 65534, 65534, "/", "/sbin/nologin"],
              ["sshd", 74, 74, "/usr/share/empty.sshd", "/sbin/nologin"],
              ["chrony", 992, 987, "/var/lib/chrony", "/sbin/nologin"],
              ["apache", 48, 48, "/usr/share/httpd", "/sbin/nologin"],
            ]
          : [
              ["root", 0, 0, "/root", "/bin/bash"],
              ["daemon", 1, 1, "/usr/sbin", "/usr/sbin/nologin"],
              ["bin", 2, 2, "/bin", "/usr/sbin/nologin"],
              ["sys", 3, 3, "/dev", "/usr/sbin/nologin"],
              ["sync", 4, 65534, "/bin", "/bin/sync"],
              ["www-data", 33, 33, "/var/www", "/usr/sbin/nologin"],
              ["nobody", 65534, 65534, "/nonexistent", "/usr/sbin/nologin"],
              ["systemd-network", 100, 102, "/run/systemd", "/usr/sbin/nologin"],
              ["systemd-resolve", 101, 103, "/run/systemd", "/usr/sbin/nologin"],
              ["messagebus", 102, 105, "/nonexistent", "/usr/sbin/nologin"],
              ["systemd-timesync", 103, 106, "/run/systemd", "/usr/sbin/nologin"],
              ["syslog", 104, 111, "/home/syslog", "/usr/sbin/nologin"],
              ["_apt", 105, 65534, "/nonexistent", "/usr/sbin/nologin"],
              ["sshd", 106, 65534, "/run/sshd", "/usr/sbin/nologin"],
            ];
      const grp =
        this.os === "rhel"
          ? [
              ["root", 0],
              ["bin", 1],
              ["daemon", 2],
              ["sys", 3],
              ["adm", 4],
              ["wheel", 10],
              ["nobody", 65534],
              ["sshd", 74],
              ["apache", 48],
              ["chrony", 987],
            ]
          : [
              ["root", 0],
              ["daemon", 1],
              ["bin", 2],
              ["sys", 3],
              ["adm", 4],
              ["tty", 5],
              ["disk", 6],
              ["cdrom", 24],
              ["sudo", 27],
              ["dip", 30],
              ["www-data", 33],
              ["plugdev", 46],
              ["lxd", 110],
              ["shadow", 42],
              ["utmp", 43],
              ["users", 100],
              ["nogroup", 65534],
              ["systemd-journal", 101],
              ["systemd-network", 102],
              ["systemd-resolve", 103],
              ["crontab", 104],
              ["messagebus", 105],
              ["systemd-timesync", 106],
              ["syslog", 111],
              ["docker", 999],
            ];
      for (const [g, gid] of grp) this.groups[g] = { gid, members: new Set() };
      for (const [u, uid, gid, home, shell] of sys)
        this.users[u] = { uid, gid, home, shell, gecos: u === "root" ? "root" : u, password: u === "root" ? "*" : "*" };
      const admin = this.os === "rhel" ? "wheel" : "sudo";
      this.addUser(this.user, {
        home: this.home,
        groups:
          this.user === "root"
            ? []
            : [admin, "adm"]
                .concat(this.os === "ubuntu" ? ["cdrom", "dip", "plugdev", "lxd"] : [])
                .concat(spec.userGroups || []),
        uid: this.user === "root" ? 0 : 1000,
        password: "$6$training$",
      });
      if (this.groups.syslog) {
        this.groups.syslog.members.add("syslog");
        this.groups.adm.members.add("syslog");
      }
      for (const u of spec.users || []) this.addUser(u.name, u);
    }
    addUser(name, o = {}) {
      if (this.users[name]) {
        if (o.groups) o.groups.forEach((g) => this.groups[g] && this.groups[g].members.add(name));
        return this.users[name];
      }
      const uid =
        o.uid ??
        Math.max(
          999,
          ...Object.values(this.users)
            .filter((u) => u.uid < 60000)
            .map((u) => u.uid),
        ) + 1;
      let gid = o.gid;
      if (gid === undefined) {
        // the user's own group takes the GID equal to the UID when it is free, else the next free one (as useradd)
        if (!this.groups[name]) {
          const used = Object.values(this.groups).map((g) => g.gid);
          const free = used.includes(uid) ? Math.max(999, ...used.filter((g) => g < 60000)) + 1 : uid;
          this.groups[name] = { gid: free, members: new Set() };
        }
        gid = this.groups[name].gid;
      }
      this.users[name] = {
        uid,
        gid,
        home: o.home || "/home/" + name,
        shell: o.shell || (this.os === "rhel" ? "/bin/bash" : "/bin/bash"),
        gecos: o.gecos || "",
        password: o.password || "!",
        locked: false,
      };
      for (const g of o.groups || []) if (this.groups[g]) this.groups[g].members.add(name);
      if (this.vfs && o.createHome !== false) this.makeHome(name);
      return this.users[name];
    }
    makeHome(name) {
      const u = this.users[name];
      if (!u || this.vfs.exists(u.home)) return;
      const g = this.primaryGroup(name);
      this.vfs.mkdirp(u.home, { owner: name, group: g, mode: this.os === "rhel" ? 0o700 : 0o750 });
      const w = (f, c, mode) => this.vfs.write(u.home + "/" + f, c, { owner: name, group: g, mode: mode || 0o644 });
      w(".bashrc", BASHRC);
      w(
        ".profile",
        '# ~/.profile: executed by the command interpreter for login shells.\nif [ -n "$BASH_VERSION" ]; then\n    if [ -f "$HOME/.bashrc" ]; then\n        . "$HOME/.bashrc"\n    fi\nfi\nif [ -d "$HOME/bin" ] ; then\n    PATH="$HOME/bin:$PATH"\nfi\n',
      );
      w(".bash_logout", "# ~/.bash_logout: executed by bash(1) when login shell exits.\n");
      this.vfs.mkdirp(u.home + "/.ssh", { owner: name, group: g, mode: 0o700 });
      w(
        ".ssh/authorized_keys",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + U.hex(name + this.name, 40) + " " + name + "@corelab-bastion\n",
        0o600,
      );
    }
    inGroup(user, group) {
      const u = this.users[user];
      if (!u) return false;
      const g = this.groups[group];
      return !!g && (g.gid === u.gid || g.members.has(user));
    }
    groupsOf(user) {
      const u = this.users[user];
      if (!u) return [];
      return Object.keys(this.groups).filter((g) => this.groups[g].gid === u.gid || this.groups[g].members.has(user));
    }
    isSudoer(user) {
      return (
        user === "root" || this.inGroup(user, "sudo") || this.inGroup(user, "wheel") || this.inGroup(user, "admin")
      );
    }
    syncAccounts() {
      const v = this.vfs;
      const users = Object.entries(this.users).sort((a, b) => a[1].uid - b[1].uid);
      v.write(
        "/etc/passwd",
        users.map(([n, u]) => `${n}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`).join("\n") + "\n",
        { mode: 0o644 },
      );
      v.write(
        "/etc/shadow",
        users.map(([n, u]) => `${n}:${u.locked ? "!" : ""}${u.password}:19650:0:99999:7:::`).join("\n") + "\n",
        { mode: 0o640, group: this.os === "rhel" ? "root" : "shadow" },
      );
      const gs = Object.entries(this.groups).sort((a, b) => a[1].gid - b[1].gid);
      v.write("/etc/group", gs.map(([n, g]) => `${n}:x:${g.gid}:${[...g.members].join(",")}`).join("\n") + "\n", {
        mode: 0o644,
      });
      v.write("/etc/gshadow", gs.map(([n, g]) => `${n}:*::${[...g.members].join(",")}`).join("\n") + "\n", {
        mode: 0o640,
        group: this.os === "rhel" ? "root" : "shadow",
      });
    }

    /* ---------------- filesystem */
    seedFs(spec) {
      const v = this.vfs;
      const dirs = [
        "/usr/bin",
        "/usr/sbin",
        "/usr/lib",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/share/doc",
        "/etc/systemd/system",
        "/etc/ssh",
        "/etc/cron.d",
        "/etc/cron.daily",
        "/etc/logrotate.d",
        "/etc/sudoers.d",
        "/etc/default",
        "/etc/security",
        "/etc/sysctl.d",
        "/etc/profile.d",
        "/etc/skel",
        "/etc/apt/sources.list.d",
        "/var/www",
        "/var/mail",
        "/var/log",
        "/var/lib",
        "/var/cache",
        "/var/tmp",
        "/var/spool/cron",
        "/opt",
        "/srv",
        "/mnt",
        "/media",
        "/boot",
        "/run",
        "/dev",
        "/proc/sys/net/ipv4",
        "/proc/sys/vm",
        "/sys/class/net",
        "/lib/systemd/system",
      ];
      dirs.forEach((d) => v.mkdirp(d));
      v.mkdirp("/tmp", { mode: 0o1777 });
      v.mkdirp("/var/tmp", { mode: 0o1777 });
      v.mkdirp("/root", { mode: 0o700 });
      v.mkdirp(this.os === "rhel" ? "/var/spool/cron" : "/var/spool/cron/crontabs", {
        mode: this.os === "rhel" ? 0o700 : 0o1730,
        group: this.os === "rhel" ? "root" : "crontab",
      });
      for (const [l, t] of [
        ["/bin", "usr/bin"],
        ["/sbin", "usr/sbin"],
        ["/lib", "usr/lib"],
      ])
        if (!v.lexists(l)) v.symlink(t, l);
      for (const u of Object.keys(this.users))
        if (u === this.user || (this.users[u].uid >= 1000 && this.users[u].uid < 60000)) this.makeHome(u);
      v.write("/root/.bashrc", BASHRC.replace(/\\\[\\033\[01;32m\\\]/, ""), { mode: 0o644 });
      const ubuntu = this.os === "ubuntu";
      const files = {
        "/etc/hostname": this.name + "\n",
        "/etc/hosts": `127.0.0.1 localhost\n127.0.1.1 ${this.name}\n${this.ip} ${this.name}\n\n# The following lines are desirable for IPv6 capable hosts\n::1 ip6-localhost ip6-loopback\nff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n`,
        "/etc/os-release": ubuntu
          ? `PRETTY_NAME="${this.osPretty}"\nNAME="Ubuntu"\nVERSION_ID="${this.osPretty.includes("24.04") ? "24.04" : "22.04"}"\nVERSION="${this.osPretty.replace("Ubuntu ", "")} (${this.osPretty.includes("24.04") ? "Noble Numbat" : "Jammy Jellyfish"})"\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\n`
          : `NAME="Red Hat Enterprise Linux"\nVERSION="9.4 (Plow)"\nID="rhel"\nID_LIKE="fedora"\nVERSION_ID="9.4"\nPRETTY_NAME="${this.osPretty}"\n`,
        "/etc/resolv.conf": ubuntu
          ? "# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch lab.local\n"
          : "# Generated by NetworkManager\nsearch lab.local\nnameserver 10.0.0.2\n",
        "/etc/fstab": ubuntu
          ? "LABEL=cloudimg-rootfs\t/\t ext4\tdiscard,errors=remount-ro\t0 1\nLABEL=UEFI\t/boot/efi\tvfat\tumask=0077\t0 1\n"
          : "UUID=7b1a3a2e-6d2e-4a8f-9a1e-2b6c1e0f4a11 /     xfs  defaults 0 0\nUUID=5c1d-9a2f                            /boot/efi vfat umask=0077,shortname=winnt 0 2\n/dev/mapper/rhel-swap none swap defaults 0 0\n",
        "/etc/crontab":
          "SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin\n\n# m h dom mon dow user\tcommand\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n25 6\t* * *\troot\ttest -x /usr/sbin/anacron || run-parts --report /etc/cron.daily\n",
        "/etc/ssh/sshd_config":
          "Include /etc/ssh/sshd_config.d/*.conf\n#Port 22\nPermitRootLogin prohibit-password\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nX11Forwarding yes\nPrintMotd no\nAcceptEnv LANG LC_*\nSubsystem\tsftp\t/usr/lib/openssh/sftp-server\n",
        "/etc/timezone": "Etc/UTC\n",
        "/etc/environment":
          'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"\n',
        "/etc/sysctl.conf":
          "#\n# /etc/sysctl.conf - Configuration file for setting system variables\n#\n#net.ipv4.ip_forward=1\n",
        "/etc/logrotate.conf": "weekly\nsu root adm\nrotate 4\ncreate\ninclude /etc/logrotate.d\n",
        "/etc/logrotate.d/rsyslog":
          "/var/log/syslog\n/var/log/auth.log\n{\n\trotate 4\n\tweekly\n\tmissingok\n\tnotifempty\n\tcompress\n\tdelaycompress\n\tsharedscripts\n\tpostrotate\n\t\t/usr/lib/rsyslog/rsyslog-rotate\n\tendscript\n}\n",
        "/etc/profile":
          "# /etc/profile: system-wide .profile file for the Bourne shell (sh(1))\nif [ -d /etc/profile.d ]; then\n  for i in /etc/profile.d/*.sh; do\n    if [ -r $i ]; then\n      . $i\n    fi\n  done\nfi\n",
        "/etc/shells": "/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/dash\n",
        "/etc/motd": "",
        "/etc/issue": `${this.osPretty} \\n \\l\n`,
        "/proc/cpuinfo": Array.from(
          { length: this.cpus },
          (_, i) =>
            `processor\t: ${i}\nvendor_id\t: GenuineIntel\nmodel name\t: Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz\ncpu MHz\t\t: 2499.998\ncpu cores\t: ${this.cpus}\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm constant_tsc rep_good nopl xtopology nonstop_tsc cpuid aperfmperf tsc_known_freq pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch invpcid_single pti fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid mpx avx512f avx512dq rdseed adx smap clflushopt clwb avx512cd avx512bw avx512vl xsaveopt xsavec xgetbv1 xsaves ida arat pku ospke\n`,
        ).join("\n"),
        "/proc/version": `Linux version ${this.kernel} (buildd@lcy02-amd64-001) (gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0, GNU ld (GNU Binutils for Ubuntu) 2.38) #72-Ubuntu SMP Fri Aug 30 13:43:12 UTC 2024\n`,
        "/proc/filesystems": "nodev\tsysfs\nnodev\ttmpfs\nnodev\tproc\n\text4\n\txfs\n\tvfat\nnodev\toverlay\n",
        "/proc/sys/vm/swappiness": "60\n",
        "/proc/sys/net/ipv4/ip_forward": "0\n",
        "/dev/null": "",
        "/dev/zero": "",
        "/dev/random": "",
        "/dev/urandom": "",
        "/var/log/syslog": "",
        "/var/log/auth.log": "",
        "/var/log/kern.log": "",
        "/var/log/dpkg.log": "",
        "/var/log/cloud-init.log": "",
      };
      if (!ubuntu) {
        delete files["/var/log/syslog"];
        delete files["/var/log/auth.log"];
        files["/var/log/messages"] = "";
        files["/var/log/secure"] = "";
        files["/etc/redhat-release"] = this.osPretty + "\n";
      } else
        files["/etc/lsb-release"] =
          `DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=${this.osPretty.includes("24.04") ? "24.04" : "22.04"}\nDISTRIB_DESCRIPTION="${this.osPretty}"\n`;
      for (const [p, c] of Object.entries(files)) v.write(p, c, { mkdirs: true });
      for (const p of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]) {
        const n = v.node(p);
        n.mode = 0o666;
        n.dev = true;
      }
      const logMode = ubuntu ? { owner: "syslog", group: "adm", mode: 0o640 } : { mode: 0o600 };
      for (const p of ubuntu
        ? ["/var/log/syslog", "/var/log/auth.log", "/var/log/kern.log"]
        : ["/var/log/messages", "/var/log/secure"])
        Object.assign(v.node(p), logMode);
      this.appendLog(ubuntu ? "/var/log/syslog" : "/var/log/messages", this.syslogSeed());
      this.appendLog(ubuntu ? "/var/log/auth.log" : "/var/log/secure", [
        `sshd[${this.pids.ssh || this.pids.sshd || 812}]: Server listening on 0.0.0.0 port 22.`,
        `sshd[${(this.pids.ssh || 812) + 1201}]: Accepted publickey for ${this.user} from 10.0.1.20 port 51522 ssh2: ED25519 SHA256:${U.b64(U.hex("fp" + this.name, 32)).slice(0, 43)}`,
        `sshd[${(this.pids.ssh || 812) + 1201}]: pam_unix(sshd:session): session opened for user ${this.user}(uid=1000) by (uid=0)`,
      ]);
      v.write(
        ubuntu ? "/etc/sudoers" : "/etc/sudoers",
        ubuntu
          ? 'Defaults\tenv_reset\nDefaults\tmail_badpass\nDefaults\tsecure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"\nDefaults\tuse_pty\n\nroot\tALL=(ALL:ALL) ALL\n%admin ALL=(ALL) ALL\n%sudo\tALL=(ALL:ALL) ALL\n\n@includedir /etc/sudoers.d\n'
          : "Defaults   !visiblepw\nroot\tALL=(ALL) \tALL\n%wheel\tALL=(ALL)\tALL\n#includedir /etc/sudoers.d\n",
        { mode: 0o440 },
      );
      v.write(
        "/etc/sudoers.d/90-cloud-init-users",
        `# Created by cloud-init v. 24.1.3 on Mon, 12 Oct 2026 00:11:42 +0000\n\n# User rules for ${this.user}\n${this.user} ALL=(ALL) NOPASSWD:ALL\n`,
        { mode: 0o440 },
      );
      if (ubuntu)
        v.write(
          "/etc/apt/sources.list",
          `# See http://help.ubuntu.com/community/UpgradeNotes for how to upgrade to\n# newer versions of the distribution.\ndeb http://ap-northeast-1.ec2.archive.ubuntu.com/ubuntu/ jammy main restricted universe multiverse\ndeb http://ap-northeast-1.ec2.archive.ubuntu.com/ubuntu/ jammy-updates main restricted universe multiverse\ndeb http://security.ubuntu.com/ubuntu jammy-security main restricted universe multiverse\n`,
          { mkdirs: true },
        );
      else
        v.write(
          "/etc/yum.repos.d/redhat.repo",
          "[rhel-9-for-x86_64-baseos-rpms]\nname = Red Hat Enterprise Linux 9 for x86_64 - BaseOS (RPMs)\nenabled = 1\n",
          { mkdirs: true },
        );
      if (ubuntu)
        v.write(
          "/etc/netplan/50-cloud-init.yaml",
          `# This file is generated from information provided by the datasource.  Changes\n# to it will not persist across an instance reboot.  To disable cloud-init's\n# network configuration capabilities, write a file\n# /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg with the following:\n# network: {config: disabled}\nnetwork:\n    ethernets:\n        eth0:\n            dhcp4: true\n            dhcp6: false\n            match:\n                macaddress: ${this.mac}\n            set-name: eth0\n    version: 2\n`,
          { mkdirs: true, mode: 0o600 },
        );
      else
        v.write(
          "/etc/NetworkManager/system-connections/cloud-init-eth0.nmconnection",
          `[connection]\nid=System eth0\nuuid=${U.hex(this.name + "nm", 8)}-${U.hex(this.name + "nm1", 4)}-${U.hex(this.name + "nm2", 4)}-${U.hex(this.name + "nm3", 4)}-${U.hex(this.name + "nm4", 12)}\ntype=ethernet\ninterface-name=eth0\n\n[ethernet]\nmac-address=${this.mac.toUpperCase()}\n\n[ipv4]\nmethod=auto\n\n[ipv6]\naddr-gen-mode=eui64\nmethod=auto\n`,
          { mkdirs: true, mode: 0o600 },
        );
      for (const s of Object.keys(this.services)) this.writeUnit(s);
      this.syncAccounts();
      this.syncBins();
      if (this.services.nginx && !spec.files?.["/etc/nginx/nginx.conf"]) this.installNginxFiles();
    }
    syslogSeed() {
      return [
        `systemd[1]: Started ${this.os === "ubuntu" ? "ssh.service - OpenBSD Secure Shell server" : "sshd.service - OpenSSH server daemon"}.`,
        "systemd[1]: Started cron.service - Regular background program processing daemon.",
        `CRON[${pidSeed + 400}]: (root) CMD (   cd / && run-parts --report /etc/cron.hourly)`,
        `systemd-timesyncd[${pidSeed + 7}]: Initial clock synchronization to Sat 2026-10-24 00:05:13.004822 UTC.`,
      ];
    }
    appendLog(path, lines) {
      const d = new Date((this.world ? this.world.now() : Date.now()) - 3600e3);
      const stamp =
        d.toUTCString().slice(8, 11) +
        " " +
        String(d.getUTCDate()).padStart(2, " ") +
        " " +
        d.toISOString().slice(11, 19);
      const n = this.vfs.node(path);
      const text =
        lines.map((l) => (/^\w{3} [ \d]\d \d\d:/.test(l) ? l : `${stamp} ${this.name} ${l}`)).join("\n") + "\n";
      if (n) n.content += text;
      else this.vfs.write(path, text, { mkdirs: true });
    }
    log(service, line) {
      // syslog + journal entry for a service
      const t = new Date(this.world ? this.world.now() : Date.now());
      const stamp =
        t.toUTCString().slice(8, 11) +
        " " +
        String(t.getUTCDate()).padStart(2, " ") +
        " " +
        t.toISOString().slice(11, 19);
      const full = `${stamp} ${this.name} ${line}`;
      (this.journal[service] = this.journal[service] || []).push(full);
      const p = this.os === "ubuntu" ? "/var/log/syslog" : "/var/log/messages";
      const n = this.vfs.node(p);
      if (n) n.content += full + "\n";
    }
    authLog(line) {
      const p = this.os === "ubuntu" ? "/var/log/auth.log" : "/var/log/secure";
      const t = new Date(this.world ? this.world.now() : Date.now());
      const stamp =
        t.toUTCString().slice(8, 11) +
        " " +
        String(t.getUTCDate()).padStart(2, " ") +
        " " +
        t.toISOString().slice(11, 19);
      const n = this.vfs.node(p);
      if (n) n.content += `${stamp} ${this.name} ${line}\n`;
    }
    writeUnit(s) {
      const def = SVC[s] || { desc: s, exec: "/usr/bin/" + s };
      const dir = this.os === "ubuntu" ? "/lib/systemd/system/" : "/usr/lib/systemd/system/";
      if (s === "systemd-journald" || this.vfs.exists(dir + s + ".service")) return;
      this.vfs.write(
        dir + s + ".service",
        `[Unit]\nDescription=${def.desc}\nAfter=network.target\n\n[Service]\n${def.oneshot ? "Type=oneshot\nRemainAfterExit=yes\n" : def.web === "nginx" ? "Type=forking\nPIDFile=/run/nginx.pid\nExecStartPre=/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'\n" : ""}ExecStart=${def.exec}\n${def.reload ? "ExecReload=/bin/kill -HUP $MAINPID\n" : ""}${def.restart ? "Restart=always\nRestartSec=10\n" : ""}${def.user ? `User=${def.user}\n` : ""}\n[Install]\nWantedBy=multi-user.target\n`,
        { mkdirs: true },
      );
    }
    installNginxFiles() {
      const v = this.vfs;
      if (!v.exists("/etc/nginx/nginx.conf"))
        v.write(
          "/etc/nginx/nginx.conf",
          "user www-data;\nworker_processes auto;\npid /run/nginx.pid;\ninclude /etc/nginx/modules-enabled/*.conf;\n\nevents {\n\tworker_connections 768;\n}\n\nhttp {\n\tsendfile on;\n\ttcp_nopush on;\n\ttypes_hash_max_size 2048;\n\tinclude /etc/nginx/mime.types;\n\tdefault_type application/octet-stream;\n\taccess_log /var/log/nginx/access.log;\n\terror_log /var/log/nginx/error.log;\n\tgzip on;\n\tinclude /etc/nginx/conf.d/*.conf;\n\tinclude /etc/nginx/sites-enabled/*;\n}\n",
          { mkdirs: true },
        );
      if (!v.exists("/etc/nginx/mime.types"))
        v.write(
          "/etc/nginx/mime.types",
          "types {\n    text/html  html htm shtml;\n    text/css   css;\n    application/javascript js;\n}\n",
        );
      v.mkdirp("/etc/nginx/conf.d");
      v.mkdirp("/etc/nginx/modules-enabled");
      if (!this.web) {
        v.write(
          "/etc/nginx/sites-available/default",
          "##\n# Default server configuration\n##\nserver {\n\tlisten 80 default_server;\n\tlisten [::]:80 default_server;\n\n\troot /var/www/html;\n\tindex index.html index.htm index.nginx-debian.html;\n\n\tserver_name _;\n\n\tlocation / {\n\t\ttry_files $uri $uri/ =404;\n\t}\n}\n",
          { mkdirs: true },
        );
        v.mkdirp("/etc/nginx/sites-enabled");
        if (!v.lexists("/etc/nginx/sites-enabled/default"))
          v.symlink("/etc/nginx/sites-available/default", "/etc/nginx/sites-enabled/default");
        v.write(
          "/var/www/html/index.nginx-debian.html",
          "<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and\nworking. Further configuration is required.</p>\n</body>\n</html>\n",
          { mkdirs: true },
        );
      }
      v.mkdirp("/var/log/nginx", { owner: "root", group: "adm" });
      if (!v.exists("/var/log/nginx/access.log"))
        v.write("/var/log/nginx/access.log", "", { owner: "www-data", group: "adm", mode: 0o640 });
      if (!v.exists("/var/log/nginx/error.log"))
        v.write("/var/log/nginx/error.log", "", { owner: "www-data", group: "adm", mode: 0o640 });
    }
    // /usr/bin entries for installed commands (so ls /usr/bin, which, type work)
    syncBins() {
      for (const p of this.pkgs)
        for (const c of (PKG[p] || "").split(" ").filter(Boolean)) {
          if (c === "[") continue;
          const sbin =
            /^(useradd|usermod|userdel|groupadd|groupdel|chpasswd|sysctl|fdisk|blkid|mkfs\.\w+|e2fsck|ufw|iptables|logrotate|visudo|pvs|vgs|lvs|pvdisplay|vgdisplay|lvdisplay|nginx|apache2ctl|httpd|tcpdump|xfs_info|crio|kubelet|swapon|swapoff|mkswap|hwclock|chronyc|parted|partprobe|wipefs|resize2fs|e2label|mke2fs|fsck(\.\w+)?|xfs_growfs|xfs_repair|pv\w+|vg\w+|lv\w+|dmidecode|ethtool|arping|locale-gen|update-locale|a2\w+|chroot|nologin)$/.test(
              c,
            );
          const path = (sbin ? "/usr/sbin/" : "/usr/bin/") + c;
          if (!this.vfs.lexists(path))
            this.vfs.write(path, "\x7fELF", { mode: 0o755, size: 30000 + (U.hash(c) % 900000) });
        }
    }
    hasCommand(c) {
      const ps = CMD_PKGS[c];
      if (!ps) return true; // shell builtins / unknown mapping
      return ps.some((p) => this.pkgs.has(p)) || (ps.includes("gawk") && this.pkgs.has("mawk"));
    }

    /* ---------------- disk */
    diskUsedBytes() {
      let n = 0;
      for (const [p, node] of this.vfs.nodes)
        if (
          node.type === "f" &&
          !p.startsWith("/proc") &&
          !p.startsWith("/dev") &&
          !p.startsWith("/usr/bin") &&
          !p.startsWith("/usr/sbin")
        )
          n += this.vfs.fileSize(node);
      return this.baseUsedGiB * 1024 ** 3 + n;
    }
    diskPct() {
      return Math.round((this.diskUsedBytes() / (this.diskGiB * 1024 ** 3)) * 100);
    }

    /* ---------------- permissions */
    // perm: 'r' | 'w' | 'x'. Returns true if `user` may access node per mode bits.
    allowed(user, node, perm) {
      if (!node) return false;
      if (perm === "w" && /i/.test(node.attrs || "")) return false; // chattr +i: not even root
      if (user === "root") return perm !== "x" || node.type === "d" || (node.mode & 0o111) !== 0;
      const bit = { r: 4, w: 2, x: 1 }[perm];
      if (node.owner === user) return ((node.mode >> 6) & bit) !== 0;
      const acl = node.acl;
      if (acl) {
        // POSIX ACL: named user, then owning/named groups (any match), each limited by the mask (= group bits)
        const mask = (node.mode >> 3) & 7;
        if (user in acl.u) return (acl.u[user] & mask & bit) !== 0;
        const gs = [[node.group, acl.g0]].concat(Object.entries(acl.g)).filter(([g]) => this.inGroup(user, g));
        if (gs.length) return gs.some(([, b]) => (b & mask & bit) !== 0);
        return (node.mode & bit) !== 0;
      }
      const shift = this.inGroup(user, node.group) ? 3 : 0;
      return ((node.mode >> shift) & bit) !== 0;
    }
    // Can `user` traverse every parent directory of path?
    traversable(user, path) {
      const parts = path.split("/").filter(Boolean);
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) {
        cur += "/" + parts[i];
        const n = this.vfs.node(cur);
        if (!n) return true;
        if (n.type === "d" && !this.allowed(user, n, "x")) return false;
      }
      return true;
    }
    canRead(user, path) {
      const n = this.vfs.node(path);
      return this.traversable(user, path) && this.allowed(user, n, "r");
    }
    canWriteFile(user, path) {
      if (!this.traversable(user, path)) return false;
      const n = this.vfs.node(path);
      if (n) return this.allowed(user, n, "w");
      const d = this.vfs.node(VFS.parent(this.vfs.real(path) || path));
      return !!d && this.allowed(user, d, "w") && this.allowed(user, d, "x");
    }
    canDelete(user, path) {
      const self = this.vfs.lnode(path);
      if (self && /[ia]/.test(self.attrs || "")) return false; // chattr +i / +a: not even root
      if (user === "root") return true;
      const parent = this.vfs.node(VFS.parent(path));
      if (
        !parent ||
        !this.traversable(user, path) ||
        !this.allowed(user, parent, "w") ||
        !this.allowed(user, parent, "x")
      )
        return false;
      if (parent.mode & 0o1000) {
        const n = this.vfs.lnode(path);
        return !!n && (n.owner === user || parent.owner === user);
      }
      return true;
    }

    /* ---------------- services & processes */
    svcName(name) {
      const n = String(name || "").replace(/\.service$/, "");
      if (n in this.services) return n;
      if (n === "sshd" && "ssh" in this.services) return "ssh";
      if (n === "ssh" && "sshd" in this.services) return "sshd";
      if (n === "docker" && this.name === "bastion") return "docker";
      return n;
    }
    svcState(name) {
      if (name === "docker" && this.name === "bastion" && this.world)
        return this.world.features.has("docker") ? "active" : "inactive";
      if (name === "containerd" && this.name === "bastion" && this.world)
        return this.world.features.has("docker") ? "active" : "inactive";
      return this.services[name];
    }
    knownService(name) {
      return (
        name in this.services ||
        (this.name === "bastion" && (name === "docker" || name === "containerd")) ||
        this.vfs.exists("/etc/systemd/system/" + name + ".service")
      );
    }
    setSvc(name, state) {
      if ((name === "docker" || name === "containerd") && this.name === "bastion" && this.world) {
        if (state === "active") this.world.features.add("docker");
        else this.world.features.delete("docker");
      }
      this.services[name] = state;
      // the process of a unit of one's own (systemctl start) is its main PID; it goes when the unit stops
      const own = this.extraProcs.find((p) => p.svcCustom === name);
      if (state === "active") this.pids[name] = own ? own.pid : ++pidSeed + 2000;
      else this.extraProcs = this.extraProcs.filter((p) => p.svcCustom !== name);
      // when the state last changed (systemctl status "since"); none for the state the host starts in
      if (this.world && !this.world.bootstrap) (this.since = this.since || {})[name] = this.world.now();
    }
    processes(extra = []) {
      const now = this.world ? this.world.now() : Date.now();
      const start = (t) => {
        const d = new Date(t);
        return now - t > 86400e3
          ? d.toUTCString().slice(8, 11) + String(d.getUTCDate()).padStart(2, "0")
          : d.toISOString().slice(11, 16);
      };
      const P = [];
      const add = (pid, ppid, user, cmd, o = {}) =>
        P.push(
          Object.assign(
            {
              pid,
              ppid,
              user,
              cmd,
              cpu: 0,
              mem: 0.1,
              vsz: 10000 + (U.hash(cmd) % 200000),
              rss: 2000 + (U.hash(cmd + 1) % 40000),
              tty: "?",
              stat: "Ss",
              start: start(o.at || this.bootAt),
              time: "0:0" + (U.hash(cmd) % 9),
            },
            o,
          ),
        );
      add(1, 0, "root", "/sbin/init splash", {
        cmd: this.os === "rhel" ? "/usr/lib/systemd/systemd --switched-root --system --deserialize 31" : "/sbin/init",
        time: "0:12",
      });
      add(2, 0, "root", "[kthreadd]", { stat: "S", vsz: 0, rss: 0 });
      add(14, 2, "root", "[rcu_preempt]", { stat: "I", vsz: 0, rss: 0 });
      add(289, 1, "root", "/lib/systemd/systemd-udevd", { stat: "Ss" });
      for (const s of Object.keys(this.services)) {
        if (this.svcState(s) !== "active") continue;
        if (this.extraProcs.some((p) => p.svcCustom === s)) continue; // listed with extraProcs below
        const exec = SVC[s]
          ? ""
          : (this.vfs.read(`/etc/systemd/system/${s}.service`) || "").match(/^ExecStart=[-@+!]*(.+)$/m);
        const base = SVC[s] || { proc: exec ? exec[1].trim() : "/usr/bin/" + s };
        const def = base.rhel && this.os === "rhel" ? Object.assign({}, base, base.rhel) : base;
        if (def.oneshot) continue;
        const pid = this.pids[s] || ++pidSeed;
        const heavy = /kubelet|dockerd|containerd|crio|postgres|firewalld/.test(def.proc || "");
        add(pid, 1, def.workers ? "root" : def.user || "root", def.proc || def.exec, {
          svc: s,
          cpu: heavy ? 1.8 : 0.0,
          mem: heavy ? 1.6 : 0.2,
          rss: heavy ? 98000 : 9000,
          time: heavy ? "14:27" : "0:01",
        });
        if (def.workers)
          for (let i = 0; i < def.workers.n; i++)
            add(pid + 1 + i, pid, def.workers.user, def.workers.cmd, { svc: s, stat: "S" });
      }
      if (this.name === "bastion" && this.world && this.world.features.has("docker")) {
        for (const c of this.world.docker.containers.filter((x) => x.status === "running")) {
          for (const p of c.ports)
            add(
              5100 + (U.hash(c.id + p.host) % 800),
              this.pids.docker || 1200,
              "root",
              `/usr/bin/docker-proxy -proto tcp -host-ip 0.0.0.0 -host-port ${p.host} -container-ip 172.17.0.${2 + this.world.docker.containers.indexOf(c)} -container-port ${p.container}`,
              { stat: "Sl", svc: "docker" },
            );
          add(
            6000 + (U.hash(c.id) % 900),
            1,
            "root",
            `/usr/bin/containerd-shim-runc-v2 -namespace moby -id ${c.id.slice(0, 64)} -address /run/containerd/containerd.sock`,
            { stat: "Sl" },
          );
        }
      }
      add(
        this.os === "rhel" ? 1010 : 734,
        1,
        "root",
        "/sbin/agetty -o -p -- \\u --keep-baud 115200,57600,38400,9600 - vt220",
        { tty: "ttyS0", stat: "Ss+" },
      );
      for (const p of this.extraProcs) add(p.pid, p.ppid || 1, p.user, p.cmd, p);
      return P.concat(extra).sort((a, b) => a.pid - b.pid);
    }
    // 1, 5 and 15 minute load: an idle base plus the CPU the processes use (uptime, top, w)
    loadavg() {
      const cpu = this.processes().reduce((s, p) => s + (p.cpu || 0), 0) / 100;
      return [0.08 + cpu, 0.11 + cpu * 0.9, 0.09 + cpu * 0.8];
    }
    // Listening sockets: [{proto, addr, port, pid, proc}]
    sockets() {
      const out = [];
      for (const s of Object.keys(this.services)) {
        if (this.svcState(s) !== "active") continue;
        // a site's own app (spec.web) listens on its port even without an entry in SVC
        const def =
          SVC[s] || (this.web && this.web.service === s ? { ports: [{ port: this.web.port }], proc: s } : null);
        if (!def || !def.ports) continue;
        const port = def.web ? this.webPort(s) : null;
        for (const p of def.ports)
          out.push({
            proto: p.proto || "tcp",
            addr: p.addr || "0.0.0.0",
            port: port || p.port,
            pid: this.pids[s],
            proc: def.web === "nginx" ? "nginx" : (def.proc || "").split(/[\s:]/)[0].split("/").pop() || s,
            svc: s,
          });
        if (!((p) => p.addr)(def.ports[0]) && (def.web || s === "ssh" || s === "sshd"))
          out.push({
            proto: "tcp6",
            addr: "[::]",
            port: port || def.ports[0].port,
            pid: this.pids[s],
            proc: def.web === "nginx" ? "nginx" : s === "ssh" || s === "sshd" ? "sshd" : s,
            svc: s,
          });
      }
      if (this.name === "bastion" && this.world && this.world.features.has("docker")) {
        for (const c of this.world.docker.containers.filter((x) => x.status === "running"))
          for (const p of c.ports)
            out.push({
              proto: "tcp",
              addr: "0.0.0.0",
              port: p.host,
              pid: 5100 + (U.hash(c.id + p.host) % 800),
              proc: "docker-proxy",
              svc: "docker",
            });
      }
      for (const l of this.listen) out.push(Object.assign({ proto: "tcp", addr: "0.0.0.0" }, l));
      return out;
    }
    webPort(s) {
      if (this.web && this.web.service === s) return this.web.port;
      const conf =
        s === "nginx"
          ? [...this.vfs.walk("/etc/nginx/sites-enabled"), ...this.vfs.walk("/etc/nginx/conf.d")]
              .map((p) => this.vfs.read(p) || "")
              .join("\n")
          : "";
      const m = conf.match(/^\s*listen\s+(\d+)/m);
      return m ? Number(m[1]) : null;
    }
    // How the host's firewall treats inbound traffic: null lets it in; "drop" discards it silently
    // (ufw's default deny, iptables DROP: the client times out); "unreachable" answers with ICMP
    // host-prohibited (firewalld's default: No route to host); "refused" is an iptables REJECT.
    firewallBlock(port, proto = "tcp", srcIp = "10.0.1.20") {
      const f = this.firewall;
      if (this.os === "ubuntu" && f.ufw.enabled) {
        for (const r of f.ufw.rules) {
          if (
            r.port &&
            r.port !== String(port) &&
            !(r.app === "OpenSSH" && port === 22) &&
            !(r.app === "Nginx Full" && (port === 80 || port === 443)) &&
            !(r.app === "Nginx HTTP" && port === 80)
          )
            continue;
          if (r.proto && r.proto !== proto) continue;
          if (r.from && r.from !== "Anywhere" && !cidrHas(r.from, srcIp)) continue;
          return r.action === "allow" || r.action === "limit" ? null : r.action === "reject" ? "refused" : "drop";
        }
        return "drop";
      }
      if (this.os === "rhel" && this.svcState("firewalld") === "active") {
        const svcPorts = { ssh: 22, http: 80, https: 443, cockpit: 9090 };
        const open =
          f.firewalld.services.some((s) => svcPorts[s] === port) || f.firewalld.ports.includes(`${port}/${proto}`);
        return open ? null : "unreachable";
      }
      const rule = f.iptables.find(
        (r) =>
          r.chain === "INPUT" &&
          (!r.dport || r.dport === String(port)) &&
          (r.target === "DROP" || r.target === "REJECT"),
      );
      return rule ? (rule.target === "REJECT" ? "refused" : "drop") : null;
    }
    firewallAllows(port, proto, srcIp) {
      return !this.firewallBlock(port, proto, srcIp);
    }
  }
  function cidrHas(cidr, ip) {
    if (!cidr.includes("/")) return cidr === ip;
    const [net, bits] = cidr.split("/");
    const toInt = (a) => a.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (toInt(ip) & mask) === (toInt(net) & mask);
  }

  const BASHRC = `# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac

HISTCONTROL=ignoreboth
HISTSIZE=1000
HISTFILESIZE=2000

# enable color support of ls and also add handy aliases
alias ls='ls --color=auto'

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias grep='grep --color=auto'
alias k='kubectl'
`;

  IG.linux = { Host, SVC, PKG, CMD_PKG, PKG_VER, SERVICE_OF_PKG, cidrHas, BASHRC };
  IG.Host = Host;
})((globalThis.IG = globalThis.IG || {}));

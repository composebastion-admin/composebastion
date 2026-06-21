package trivy

default ignore = false

# These exceptions are limited to bundled third-party CLI binaries whose latest
# upstream releases still carry these Go module versions. Keep each entry pinned
# to the exact package and installed version so new findings continue to fail CI.

ignore {
	input.VulnerabilityID == "CVE-2026-53488"
	input.PkgName == "github.com/containerd/containerd/v2"
	input.InstalledVersion == "v2.3.1"
}

ignore {
	input.VulnerabilityID == "CVE-2026-53489"
	input.PkgName == "github.com/containerd/containerd/v2"
	input.InstalledVersion == "v2.3.1"
}

ignore {
	input.VulnerabilityID == "CVE-2026-53492"
	input.PkgName == "github.com/containerd/containerd/v2"
	input.InstalledVersion == "v2.3.1"
}

ignore {
	input.VulnerabilityID == "CVE-2026-46680"
	input.PkgName == "github.com/containerd/containerd/v2"
	input.InstalledVersion == "v2.2.3"
}

ignore {
	input.VulnerabilityID == "CVE-2026-53488"
	input.PkgName == "github.com/containerd/containerd/v2"
	input.InstalledVersion == "v2.2.3"
}

ignore {
	input.VulnerabilityID == "CVE-2026-53489"
	input.PkgName == "github.com/containerd/containerd/v2"
	input.InstalledVersion == "v2.2.3"
}

ignore {
	input.VulnerabilityID == "CVE-2026-53492"
	input.PkgName == "github.com/containerd/containerd/v2"
	input.InstalledVersion == "v2.2.3"
}

ignore {
	input.VulnerabilityID == "CVE-2026-34040"
	input.PkgName == "github.com/docker/docker"
	input.InstalledVersion == "v28.5.2+incompatible"
}

ignore {
	input.VulnerabilityID == "CVE-2026-42504"
	input.PkgName == "stdlib"
	input.InstalledVersion == "v1.26.3"
}

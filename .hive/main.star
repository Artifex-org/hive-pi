# Native Origin gate. No host execution, org secrets, private overlay, service
# account or deployment lane. Public fork submission is NOT enabled by this
# file: candidate CI is admitted by the trusted default-branch policy.
#
# Keep GitHub Actions until operator cutover. Once GitHub is a read-only mirror,
# its checks are not merge authority; Origin's exact-candidate gate is.
hive.pipeline(
    name = "ci",
    on = [hive.on.pull_request(), hive.on.push(branches = ["main"])],
    steps = [
        hive.step(
            name = "gitleaks",
            image = "node:24-bookworm",
            runtime = "container",
            role = "lint",
            secrets = [],
            run = """
set -eu
# History scanning must not silently succeed on a shallow checkout.
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
    git fetch --unshallow origin
fi
test "$(git rev-parse --is-shallow-repository)" = false
case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "unsupported gitleaks architecture" >&2; exit 1 ;;
esac
version=8.28.0
asset="gitleaks_${version}_linux_${arch}.tar.gz"
curl -fsSL -o /tmp/gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}"
curl -fsSL -o /tmp/gitleaks-checksums.txt "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_checksums.txt"
cd /tmp
grep " ${asset}$" gitleaks-checksums.txt > gitleaks-selected.sha256
test "$(wc -l < gitleaks-selected.sha256)" -eq 1
# The official checksum names its release asset, not our temporary filename.
mv gitleaks.tar.gz "$asset"
sha256sum -c gitleaks-selected.sha256
tar -xzf "$asset" gitleaks
cd -
/tmp/gitleaks detect --source . --redact --verbose
/tmp/gitleaks detect --source . --no-git --redact --verbose
""",
            resources = hive.resources(cpu = 1, memory = "1Gi"),
            timeout = "10m",
        ),
        hive.step(
            name = "check",
            image = "mcr.microsoft.com/playwright:v1.62.1-noble",
            runtime = "container",
            role = "test",
            secrets = [],
            run = """
set -eu
test "$(node -p \"process.versions.node.split(\'.\')[0]\")" = 24 || { echo "CI browser image must provide Node 24" >&2; exit 1; }
npm ci --ignore-scripts
# System browser dependencies are preinstalled in this version-matched image.
# Runtime task capabilities do not permit apt installation.
npx --no-install playwright-core install chromium-headless-shell
env -u FORCE_COLOR npm run check -- --maxWorkers=2
""",
            resources = hive.resources(cpu = 2, memory = "4Gi"),
            timeout = "30m",
        ),
    ],
)

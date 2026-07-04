#!/usr/bin/env bash
#
# install-assetstudio-cli.sh
# ---------------------------
# Installs a working, cross-platform AssetStudio CLI on Linux.
#
# AssetStudio's official GUI (Perfare/AssetStudio) is Windows-only (WinForms).
# This script builds AssetStudioModCLI from aelurum's maintained fork
# (https://github.com/aelurum/AssetStudio), which provides a command-line tool
# for extracting/exporting Unity assets that runs on Linux, macOS and Windows.
#
# Tested on: Ubuntu 24.04 (x86_64), .NET 8 SDK.
#
set -euo pipefail

REPO_URL="https://github.com/aelurum/AssetStudio.git"
WORK_DIR="${WORK_DIR:-/tmp/AssetStudioMod-build}"
INSTALL_DIR="${INSTALL_DIR:-/opt/assetstudio-cli}"
LAUNCHER="${LAUNCHER:-/usr/local/bin/assetstudio}"

# Detect RID (only linux-x64 / linux-arm64 have bundled native libs upstream)
case "$(uname -m)" in
  x86_64)  RID="linux-x64" ;;
  aarch64) RID="linux-arm64" ;;
  *) echo "Unsupported arch: $(uname -m)"; exit 1 ;;
esac

echo ">> 1/5  Installing .NET 8 SDK (if missing)"
if ! command -v dotnet >/dev/null 2>&1 || ! dotnet --list-sdks 2>/dev/null | grep -q '^8\.'; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y dotnet-sdk-8.0
  else
    echo "apt-get not found. Install .NET 8 SDK manually: https://dotnet.microsoft.com/download/dotnet/8.0"
    exit 1
  fi
fi
dotnet --version

echo ">> 2/5  Cloning $REPO_URL"
rm -rf "$WORK_DIR"
git clone --depth 1 "$REPO_URL" "$WORK_DIR"
cd "$WORK_DIR"

echo ">> 3/5  Constraining build to net8.0 (skips Windows-only TFMs)"
# The core projects multi-target net472/net8.0/net9.0(-windows). With only the
# .NET 8 SDK present we build the net8.0 (Linux) code path. This collapses any
# <TargetFrameworks> list that contains net8.0 down to just net8.0.
for proj in \
  AssetStudioCLI/AssetStudioCLI.csproj \
  AssetStudio/AssetStudio.csproj \
  AssetStudioUtility/AssetStudioUtility.csproj \
  AssetStudio.PInvoke/AssetStudio.PInvoke.csproj \
  AssetStudioFBXWrapper/AssetStudioFBXWrapper.csproj ; do
  sed -i -E 's#<TargetFrameworks>[^<]*net8\.0[^<]*</TargetFrameworks>#<TargetFrameworks>net8.0</TargetFrameworks>#' "$proj"
done

echo ">> 4/5  Publishing AssetStudioModCLI for $RID"
# Building with -r <RID> skips the Windows/portable copy targets (guarded by
# RuntimeIdentifier=='') and runs the RID-specific target that lays the correct
# native .so files next to the executable.
rm -rf "$WORK_DIR/publish"
dotnet publish AssetStudioCLI/AssetStudioCLI.csproj \
  -c Release -f net8.0 -r "$RID" --self-contained false \
  -o "$WORK_DIR/publish"

echo ">> 5/5  Installing to $INSTALL_DIR and launcher $LAUNCHER"
sudo rm -rf "$INSTALL_DIR"
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r "$WORK_DIR/publish/." "$INSTALL_DIR"/
sudo chmod +x "$INSTALL_DIR/AssetStudioModCLI"

sudo tee "$LAUNCHER" >/dev/null <<EOF
#!/usr/bin/env bash
exec "$INSTALL_DIR/AssetStudioModCLI" "\$@"
EOF
sudo chmod +x "$LAUNCHER"

echo
echo "Done. Try:  assetstudio --help"
echo "Basic use:  assetstudio <asset folder> -m info      # list assets"
echo "            assetstudio <asset folder> -o out/       # export all"

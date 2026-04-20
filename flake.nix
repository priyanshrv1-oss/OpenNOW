{
  description = "Custom GeForce Now Client Named OpenNOW";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "opennow";
          version = "1.0.0";

          src = ./opennow-stable;

          npmDepsHash = "sha256-iMoYLIydDGTHgm6eMdoXb65NcPFXfWcVztmvMRHmCJs=";
          npmDepsFetcherVersion = 2;
          makeCacheWritable = true;
          forceGitDeps = true;

          npmInstallFlags = [
            "--legacy-peer-deps"
            "--no-audit"
          ];
          npmFlags = [
            "--legacy-peer-deps"
            "--no-audit"
          ];
          npmCiFlags = [
            "--legacy-peer-deps"
            "--no-audit"
          ];

          nativeBuildInputs = [
            pkgs.pkg-config
            pkgs.python3
            pkgs.gcc
            pkgs.makeWrapper
            pkgs.copyDesktopItems
          ];

          buildInputs = [
            pkgs.openssl
            pkgs.zlib
            pkgs.electron
          ];

          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/opennow
            cp -r . $out/lib/opennow

            mkdir -p $out/bin
            for path in "out/main/index.js" "dist/main/index.js" "dist-electron/main.js"; do
              if [ -f "$out/lib/opennow/$path" ]; then
                MAIN_SCRIPT="$out/lib/opennow/$path"
                break
              fi
            done
            : ''${MAIN_SCRIPT:="$out/lib/opennow"}

            makeWrapper ${pkgs.electron}/bin/electron $out/bin/opennow \
              --add-flags "$MAIN_SCRIPT" \
              --set NODE_ENV production \
              --add-flags "--enable-features=WaylandWindowDecorations --platform-hint=auto"

            mkdir -p $out/share/icons/hicolor/512x512/apps
            if [ -f "src/renderer/src/assets/opennow-logo.png" ]; then
              cp src/renderer/src/assets/opennow-logo.png $out/share/icons/hicolor/512x512/apps/opennow.png
            fi
            runHook postInstall
          '';
        };
      }
    );
}

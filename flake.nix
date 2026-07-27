{
  description = "Minimal pi flake with bundled extensions";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    systems.url = "github:nix-systems/default";
    pi-formatter = {
      url = "github:tenzir/pi-formatter";
      flake = false;
    };
    pi-terminal-theme = {
      url = "github:mavam/pi-terminal-theme";
      flake = false;
    };
    pi-service-tier = {
      url = "github:mavam/pi-service-tier";
      flake = false;
    };
    pi-anthropic-auth = {
      url = "github:gotgenes/pi-anthropic-auth";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      pi-formatter,
      pi-terminal-theme,
      pi-service-tier,
      pi-anthropic-auth,
    }:
    let
      lib = nixpkgs.lib;
      version = "unstable-${self.shortRev or "dirty"}";
      npmDepsHash = "sha256-5pHRwxpKg95/phOcYHeWdvPJNtSOhiw7PRoVxsuh0RM=";
      forEachSystem = lib.genAttrs (import systems);
      mkExtension =
        pkgs: src:
        let
          package = builtins.fromJSON (builtins.readFile "${src}/package.json");
        in
        pkgs.runCommand "${package.name}-${package.version}" { } ''
          cp -r ${src} $out
        '';
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };

          base = pkgs.callPackage ./nix/package.nix {
            src = self;
            inherit version npmDepsHash;
          };

          piFormatterExtension = mkExtension pkgs pi-formatter;
          piTerminalThemeExtension = mkExtension pkgs pi-terminal-theme;
          piServiceTierExtension = mkExtension pkgs pi-service-tier;
          piAnthropicAuthExtension = mkExtension pkgs pi-anthropic-auth;

          piDelegatorExtension = pkgs.runCommand "pi-delegator-extension" { } ''
            mkdir -p $out
            cp -r ${./nix/delegator}/. $out/
          '';

          piStatusbarExtension = pkgs.runCommand "pi-statusbar-extension" { } ''
            mkdir -p $out
            cp -r ${./nix/statusbar}/. $out/
          '';
        in
        rec {
          pi = pkgs.symlinkJoin {
            name = "pi-${version}";
            paths = [ base ];
            nativeBuildInputs = [ pkgs.makeWrapper ];

            postBuild = ''
              wrapProgram $out/bin/pi \
                --set PI_OFFLINE true \
                --prefix PATH : "${
                  lib.makeBinPath [
                    pkgs.fd
                    pkgs.ripgrep
                    pkgs.nodejs
                  ]
                }" \
                --add-flags "--tools read,bash,edit,write,grep,find,delegate" \
                --add-flags "--extension ${piFormatterExtension}" \
                --add-flags "--extension ${piTerminalThemeExtension}" \
                --add-flags "--extension ${piServiceTierExtension}" \
                --add-flags "--extension ${piAnthropicAuthExtension}" \
                --add-flags "--extension ${piDelegatorExtension}/index.ts" \
              --add-flags "--extension ${piStatusbarExtension}/index.ts"
            '';

            meta = base.meta // {
              mainProgram = "pi";
            };
          };

          default = pi;
        }
      );
    };
}

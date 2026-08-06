# =========================================================================
# Vibing – Capacitor Mobile Build Environment Makefile
# =========================================================================
# One-command bootstrap of everything needed to turn this PWA into a
# real Android (and optionally iOS) app with Capacitor.
#
# USAGE:
#   make setup          # installs npm deps + Capacitor + Android SDK + (macOS) iOS toolchain
#   make init            # capacitor init + add android/ios platforms (run once)
#   make sync            # copy web assets into native projects (run after edits)
#   make android          # open project in Android Studio
#   make ios              # open project in Xcode (macOS only)
#   make build-apk        # build a debug APK from the command line
#   make run-ios           # build + run on a connected iPhone or simulator (macOS only)
#   make all             # setup + init in one go
#   make clean            # remove native platforms + node_modules
#
# Re-run `make setup` any time on a fresh machine to fully redeploy the
# toolchain — it is idempotent (safe to run multiple times).
#
# NOTE ON iOS: Xcode only runs on macOS. This Makefile detects the host OS:
#   - On macOS: installs Xcode Command Line Tools, CocoaPods, and the iOS
#     platform, and lets you build/run on your iPhone via Xcode.
#   - On Linux/other: iOS-specific steps are skipped with a warning. You can
#     still `cap add ios` to generate project files, but you'll need a Mac
#     (or a cloud Mac / CI like Codemagic, Bitrise, GitHub Actions macOS
#     runners) to actually open Xcode, sign, and install to a device.
# =========================================================================

SHELL := /bin/bash
UNAME_S := $(shell uname -s)

# ---- Config -------------------------------------------------------------
APP_ID       ?= com.vibing.app
APP_NAME     ?= Vibing
WEB_DIR      ?= public
ANDROID_SDK_ROOT ?= $(HOME)/android-sdk
CMDLINE_TOOLS_VERSION ?= 11076708
NODE_MIN_MAJOR := 22

# ---- Phony targets --------------------------------------------------------
.PHONY: all setup npm-deps system-deps java-deps android-sdk cap-packages \
        ios-deps init sync android ios build-apk run-ios clean doctor dev-env

all: setup init

# ---------------------------------------------------------------------------
# ONE-COMMAND FULL SETUP
# ---------------------------------------------------------------------------
setup: system-deps java-deps android-sdk ios-deps npm-deps cap-packages
	@echo ""
	@echo "✅  All Capacitor mobile build dependencies installed."
	@echo "    Next: run 'make init' to create the Android + iOS projects."
	@echo ""

# ---------------------------------------------------------------------------
# System-level packages (Node.js, unzip, curl, build tools)
# Supports Debian/Ubuntu (apt) and macOS (brew). Extend as needed.
# ---------------------------------------------------------------------------
system-deps:
	@echo ">> Checking base system packages..."
	@if command -v apt-get >/dev/null 2>&1; then \
		sudo apt-get update -y && \
		sudo apt-get install -y curl unzip git build-essential ca-certificates; \
		if ! command -v node >/dev/null 2>&1 || [ "$$(node -v | sed 's/v//;s/\..*//')" -lt "$(NODE_MIN_MAJOR)" ]; then \
			echo ">> Installing Node.js 22.x via NodeSource..."; \
			curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -; \
			sudo apt-get install -y nodejs; \
		fi; \
	elif command -v brew >/dev/null 2>&1; then \
		brew install node unzip git; \
	else \
		echo "!! Unsupported OS: install curl, unzip, git and Node.js >= $(NODE_MIN_MAJOR) manually."; \
	fi
	@node -v && npm -v

# ---------------------------------------------------------------------------
# Java (required by Android Gradle build)
# ---------------------------------------------------------------------------
java-deps:
	@echo ">> Checking Java (OpenJDK 17)..."
	@if ! command -v java >/dev/null 2>&1; then \
		if command -v apt-get >/dev/null 2>&1; then \
			sudo apt-get install -y openjdk-17-jdk; \
		elif command -v brew >/dev/null 2>&1; then \
			brew install openjdk@17; \
		fi; \
	fi
	@java -version

# ---------------------------------------------------------------------------
# Android SDK (command-line tools + platform + build-tools + platform-tools)
# Installed locally under $(ANDROID_SDK_ROOT) so it's self-contained and
# easy to wipe/redeploy without touching a system-wide Android Studio setup.
# ---------------------------------------------------------------------------
android-sdk:
	@echo ">> Setting up Android SDK at $(ANDROID_SDK_ROOT)..."
	@mkdir -p "$(ANDROID_SDK_ROOT)/cmdline-tools"
	@if [ ! -d "$(ANDROID_SDK_ROOT)/cmdline-tools/latest" ]; then \
		OS_NAME="$$(uname -s)"; \
		if [ "$$OS_NAME" = "Darwin" ]; then PLAT=mac; else PLAT=linux; fi; \
		echo ">> Downloading Android command-line tools ($$PLAT)..."; \
		curl -fsSL -o /tmp/cmdline-tools.zip \
			"https://dl.google.com/android/repository/commandlinetools-$${PLAT}-$(CMDLINE_TOOLS_VERSION)_latest.zip"; \
		unzip -q -o /tmp/cmdline-tools.zip -d "$(ANDROID_SDK_ROOT)/cmdline-tools"; \
		mv "$(ANDROID_SDK_ROOT)/cmdline-tools/cmdline-tools" "$(ANDROID_SDK_ROOT)/cmdline-tools/latest"; \
		rm -f /tmp/cmdline-tools.zip; \
	fi
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$$PATH"; \
	yes | sdkmanager --sdk_root="$(ANDROID_SDK_ROOT)" --licenses >/dev/null 2>&1 || true; \
	sdkmanager --sdk_root="$(ANDROID_SDK_ROOT)" \
		"platform-tools" \
		"platforms;android-34" \
		"build-tools;34.0.0"
	@echo ""
	@echo ">> Add these to your shell profile (~/.bashrc or ~/.zshrc) to persist:"
	@echo "   export ANDROID_SDK_ROOT=$(ANDROID_SDK_ROOT)"
	@echo "   export ANDROID_HOME=$(ANDROID_SDK_ROOT)"
	@echo "   export PATH=\$$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:\$$ANDROID_SDK_ROOT/platform-tools:\$$PATH"
	@echo ""
	@grep -qxF 'export ANDROID_SDK_ROOT=$(ANDROID_SDK_ROOT)' $(HOME)/.bashrc 2>/dev/null || \
		( echo 'export ANDROID_SDK_ROOT=$(ANDROID_SDK_ROOT)' >> $(HOME)/.bashrc; \
		  echo 'export ANDROID_HOME=$(ANDROID_SDK_ROOT)' >> $(HOME)/.bashrc; \
		  echo 'export PATH=$$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$$ANDROID_SDK_ROOT/platform-tools:$$PATH' >> $(HOME)/.bashrc; \
		  echo ">> Appended Android env vars to ~/.bashrc" )

# ---------------------------------------------------------------------------
# iOS toolchain (macOS only): Xcode CLT + CocoaPods
# Xcode itself must be installed manually from the App Store (Apple does
# not allow scripted/CLI installation of full Xcode), but everything else
# needed by Capacitor (Command Line Tools, CocoaPods, ios-deploy) is
# installed here automatically.
# ---------------------------------------------------------------------------
ios-deps:
ifeq ($(UNAME_S),Darwin)
	@echo ">> Setting up iOS build tools (macOS detected)..."
	@if ! xcode-select -p >/dev/null 2>&1; then \
		echo ">> Installing Xcode Command Line Tools..."; \
		xcode-select --install || true; \
		echo "!! A GUI installer popup may have opened — accept it, then re-run 'make setup'."; \
	fi
	@if ! command -v brew >/dev/null 2>&1; then \
		echo ">> Installing Homebrew..."; \
		/bin/bash -c "$$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; \
	fi
	@if ! command -v pod >/dev/null 2>&1; then \
		echo ">> Installing CocoaPods..."; \
		brew install cocoapods || sudo gem install cocoapods; \
	fi
	@if ! command -v ios-deploy >/dev/null 2>&1; then \
		echo ">> Installing ios-deploy (installs builds onto a physical iPhone)..."; \
		brew install ios-deploy || npm install -g ios-deploy; \
	fi
	@if [ ! -d "/Applications/Xcode.app" ]; then \
		echo ""; \
		echo "‼️  Full Xcode.app not found in /Applications."; \
		echo "    Apple requires this be installed manually from the App Store"; \
		echo "    (search 'Xcode'), then run: sudo xcodebuild -license accept"; \
		echo ""; \
	else \
		sudo xcodebuild -license accept 2>/dev/null || true; \
		echo ">> Xcode found. Verifying command line tools path..."; \
		sudo xcode-select -s /Applications/Xcode.app/Contents/Developer 2>/dev/null || true; \
	fi
	@pod --version 2>/dev/null || true
else
	@echo ""
	@echo "⚠️  Skipping iOS toolchain setup: not running on macOS."
	@echo "    iOS apps can only be built/signed/run via Xcode, which is macOS-only."
	@echo "    You can still generate the ios/ project files with 'make init' and"
	@echo "    'npx cap add ios', then move the project to a Mac (or use a cloud Mac"
	@echo "    / CI service such as Codemagic, Bitrise, or GitHub Actions macOS"
	@echo "    runners) to open it in Xcode and install to your iPhone."
	@echo ""
endif

# ---------------------------------------------------------------------------
# Project npm dependencies (existing backend deps)
# ---------------------------------------------------------------------------
npm-deps:
	@echo ">> Installing existing project npm dependencies..."
	npm install

# ---------------------------------------------------------------------------
# Capacitor packages (core, cli, android platform)
# ---------------------------------------------------------------------------
cap-packages:
	@echo ">> Installing Capacitor packages..."
	npm install --save @capacitor/core @capacitor/android @capacitor/ios
	npm install --save-dev @capacitor/cli
	@echo ">> Installing common Capacitor plugins..."
	npm install --save @capacitor/app @capacitor/splash-screen @capacitor/status-bar @capacitor/filesystem @capacitor/preferences
	@echo ">> Installing native audio plugin (volume control + background playback)..."
	npm install --save @capgo/capacitor-native-audio

# ---------------------------------------------------------------------------
# Initialize Capacitor project + add Android platform (run once)
# ---------------------------------------------------------------------------
init:
	@if [ ! -f "capacitor.config.json" ] && [ ! -f "capacitor.config.ts" ]; then \
		npx cap init "$(APP_NAME)" "$(APP_ID)" --web-dir="$(WEB_DIR)"; \
	else \
		echo ">> Capacitor already initialized, skipping 'cap init'."; \
	fi
	@if [ ! -d "android" ]; then \
		npx cap add android; \
	else \
		echo ">> android/ platform already exists, skipping 'cap add android'."; \
	fi
ifeq ($(UNAME_S),Darwin)
	@if [ ! -d "ios" ]; then \
		npx cap add ios; \
		echo ""; \
		echo "‼️  MANUAL STEPS NEEDED for native audio + your HTTP backend:"; \
		echo "    1) Background playback: open ios/App/App.xcworkspace in Xcode,"; \
		echo "       select the App target, go to Signing & Capabilities, click"; \
		echo "       '+ Capability', add 'Background Modes', and check 'Audio,"; \
		echo "       AirPlay, and Picture in Picture'. Without this,"; \
		echo "       @capgo/capacitor-native-audio playback stops when backgrounded."; \
		echo "    2) Cleartext HTTP: capacitor.config.json already sets"; \
		echo "       server.cleartext=true for the http://213.32.91.190:3838 backend,"; \
		echo "       but iOS App Transport Security can still need an explicit"; \
		echo "       exception. If audio/API calls fail with an ATS error in Xcode's"; \
		echo "       console, add this to ios/App/App/Info.plist inside the root"; \
		echo "       <dict>:"; \
		echo "         <key>NSAppTransportSecurity</key>"; \
		echo "         <dict>"; \
		echo "           <key>NSExceptionDomains</key>"; \
		echo "           <dict>"; \
		echo "             <key>213.32.91.190</key>"; \
		echo "             <dict>"; \
		echo "               <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>"; \
		echo "             </dict>"; \
		echo "           </dict>"; \
		echo "         </dict>"; \
		echo ""; \
	else \
		echo ">> ios/ platform already exists, skipping 'cap add ios'."; \
	fi
else
	@echo ">> Not on macOS: skipping 'cap add ios'. Run this on a Mac later, or"
	@echo "   run 'npx cap add ios' manually if you just want the project files."
endif
	@$(MAKE) sync

# ---------------------------------------------------------------------------
# Sync web assets into native project(s) (run after any web/ or config change)
# ---------------------------------------------------------------------------
sync:
	npx cap sync android
ifeq ($(UNAME_S),Darwin)
	@if [ -d "ios" ]; then npx cap sync ios; fi
endif

# ---------------------------------------------------------------------------
# Open Android Studio for the native project
# ---------------------------------------------------------------------------
android:
	npx cap open android

# ---------------------------------------------------------------------------
# Open Xcode for the native iOS project (macOS only)
# ---------------------------------------------------------------------------
ios:
ifeq ($(UNAME_S),Darwin)
	npx cap open ios
else
	@echo "‼️  'make ios' requires macOS + Xcode. Run this target on your Mac."
endif

# ---------------------------------------------------------------------------
# Build a debug APK from the CLI (no Android Studio needed)
# Output: android/app/build/outputs/apk/debug/app-debug.apk
# ---------------------------------------------------------------------------
build-apk: sync
	cd android && ./gradlew assembleDebug
	@echo ""
	@echo "✅  APK built: android/app/build/outputs/apk/debug/app-debug.apk"

# ---------------------------------------------------------------------------
# Build + run on a connected iPhone (or simulator) via CLI, macOS only.
# For a physical iPhone: plug it in, trust the computer, and make sure your
# Apple ID / signing team is set once in Xcode (Signing & Capabilities tab).
# ---------------------------------------------------------------------------
run-ios: sync
ifeq ($(UNAME_S),Darwin)
	npx cap run ios
else
	@echo "‼️  'make run-ios' requires macOS + Xcode + a Mac connected to your iPhone."
endif

# ---------------------------------------------------------------------------
# Headless SERVER dev environment (no Android SDK, no Xcode/iOS toolchain).
# Use this on a Linux dev/CI server where you're only editing/testing the
# JS plugin-adapter code (playback.js, controls.js, state.js, the native
# audio adapter) and running the Express backend — not building/opening
# native Android Studio or Xcode projects. Actual .ipa/.apk builds still
# happen via Codemagic (iOS) or 'make android'/'make build-apk' on a
# machine with the Android SDK (see 'make setup' for that).
# ---------------------------------------------------------------------------
dev-env: system-deps npm-deps cap-packages
	@echo ""
	@echo "✅  Server dev environment ready."
	@echo "    - npm deps + Capacitor JS packages installed"
	@echo "    - @capgo/capacitor-native-audio installed"
	@echo "    - No Android SDK / Xcode installed (not needed for JS-only work)"
	@echo "    Run 'npm run dev' or 'node server.js' to start the backend."
	@echo ""

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
doctor:
	npx cap doctor

# ---------------------------------------------------------------------------
# Clean up native platforms + node_modules (keeps SDK/toolchain installed)
# ---------------------------------------------------------------------------
clean:
	rm -rf android ios node_modules
	@echo ">> Removed android/, ios/, and node_modules/. Run 'make all' to rebuild."

# ---------------------------------------------------------------------------
# Quick platform check — shows what this machine can/can't build
# ---------------------------------------------------------------------------
platform-check:
	@echo "Host OS: $(UNAME_S)"
ifeq ($(UNAME_S),Darwin)
	@echo "✅ Can build both Android and iOS on this machine."
else
	@echo "✅ Can build Android on this machine."
	@echo "❌ Cannot build/run iOS here — need a Mac with Xcode for that step."
endif
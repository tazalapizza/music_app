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
#   make emulator-create    # download an Android system image + create a test AVD (no Mac needed)
#   make emulator-run        # boot the AVD (leave running in its own terminal)
#   make emulator-list        # list AVDs on this machine
#   make emulator-delete       # remove the AVD (e.g. to recreate with different settings)
#   make all             # setup + init in one go
#   make clean            # remove native platforms + node_modules
#
# Re-run `make setup` any time on a fresh machine to fully redeploy the
# toolchain — it is idempotent (safe to run multiple times).
#
# TESTING WITHOUT A MAC: you don't need iOS/Xcode to test this app - Android
# + the emulator targets above work fully on Linux/Windows, no Mac required.
# Typical flow: `make init` (creates android/), `make emulator-create` (one-
# time download + AVD setup), `make emulator-run` in one terminal, then in
# another terminal `npx cap run android` (or `make android` to use Android
# Studio's Run button instead) to install the app onto the running emulator.
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
AVD_NAME       ?= Vibing_Test
AVD_API_LEVEL  ?= 34
AVD_SYSTEM_IMAGE ?= system-images;android-$(AVD_API_LEVEL);google_apis;x86_64
AVD_DEVICE     ?= pixel_7

# ---- Phony targets --------------------------------------------------------
.PHONY: all setup npm-deps system-deps java-deps android-sdk cap-packages \
        ios-deps init sync android ios build-apk run-ios clean doctor dev-env \
        emulator-deps emulator-create emulator-run emulator-list emulator-delete

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
# Android EMULATOR (AVD) — lets you run/test the app with no physical device
# and no Mac (this is the recommended path for you since you don't have a
# Mac for iOS — Android + emulator works fully on Linux/Windows/macOS).
#
# Kept separate from android-sdk/setup rather than bundled in automatically:
# the emulator package + a system image is a large download (1-2GB+) that
# not everyone building this project wants pulled in by default.
#
# x86_64 image is used unconditionally (not arm64) because this is intended
# for a Linux or Intel-based dev machine; only Apple Silicon Macs would
# need arm64-v8a instead, which doesn't apply to your setup.
# ---------------------------------------------------------------------------
emulator-deps: android-sdk
	@echo ">> Installing Android Emulator + system image ($(AVD_SYSTEM_IMAGE))..."
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$(ANDROID_SDK_ROOT)/emulator:$$PATH"; \
	yes | sdkmanager --sdk_root="$(ANDROID_SDK_ROOT)" --licenses >/dev/null 2>&1 || true; \
	sdkmanager --sdk_root="$(ANDROID_SDK_ROOT)" \
		"emulator" \
		"platforms;android-$(AVD_API_LEVEL)" \
		"$(AVD_SYSTEM_IMAGE)"
	@echo ">> Emulator + system image installed."

# Creates the AVD if it doesn't already exist (idempotent - re-running
# 'make emulator-create' is safe and just skips creation on subsequent
# runs). `echo "no" |` answers the interactive "create a custom hardware
# profile?" prompt avdmanager asks, so this works non-interactively.
emulator-create: emulator-deps
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$(ANDROID_SDK_ROOT)/emulator:$$PATH"; \
	if avdmanager list avd | grep -q "Name: $(AVD_NAME)$$"; then \
		echo ">> AVD '$(AVD_NAME)' already exists, skipping creation."; \
	else \
		echo ">> Creating AVD '$(AVD_NAME)' ($(AVD_SYSTEM_IMAGE), device: $(AVD_DEVICE))..."; \
		echo "no" | avdmanager create avd \
			--name "$(AVD_NAME)" \
			--package "$(AVD_SYSTEM_IMAGE)" \
			--device "$(AVD_DEVICE)" \
			--force; \
	fi
	@echo ""
	@echo "✅  AVD ready. Run 'make emulator-run' to start it, or 'make emulator-list'"
	@echo "    to see all AVDs on this machine."
	@echo ""

# Boots the emulator window. Leave this running in one terminal, then in
# another terminal run 'npx cap run android' (or open Android Studio and
# hit Run) to install/launch the app onto it - same as a physical device,
# just virtual. First boot is noticeably slower (cold boot) than later ones.
emulator-run:
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$(ANDROID_SDK_ROOT)/emulator:$$PATH"; \
	if ! avdmanager list avd | grep -q "Name: $(AVD_NAME)$$"; then \
		echo "!! AVD '$(AVD_NAME)' doesn't exist yet. Run 'make emulator-create' first."; \
		exit 1; \
	fi; \
	emulator -avd "$(AVD_NAME)"

emulator-list:
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$(ANDROID_SDK_ROOT)/emulator:$$PATH"; \
	avdmanager list avd

emulator-delete:
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$(ANDROID_SDK_ROOT)/emulator:$$PATH"; \
	avdmanager delete avd --name "$(AVD_NAME)"
	@echo ">> Deleted AVD '$(AVD_NAME)'."

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
# Android emulator, no Android Studio GUI or Mac needed.
# AVD_NAME/AVD_DEVICE/AVD_SYSIMG are overridable, e.g.:
#   make avd-create AVD_NAME=pixel6
# ---------------------------------------------------------------------------
AVD_NAME     ?= vibing-test
AVD_DEVICE   ?= pixel_6
AVD_SYSIMG   ?= system-images;android-34;google_apis;x86_64

avd-create:
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$(ANDROID_SDK_ROOT)/emulator:$$PATH"; \
	if avdmanager list avd | grep -q "Name: $(AVD_NAME)$$"; then \
		echo ">> AVD '$(AVD_NAME)' already exists, skipping creation."; \
	else \
		echo ">> Installing system image $(AVD_SYSIMG)..."; \
		yes | sdkmanager --sdk_root="$(ANDROID_SDK_ROOT)" "$(AVD_SYSIMG)"; \
		echo ">> Creating AVD '$(AVD_NAME)'..."; \
		echo "no" | avdmanager create avd -n "$(AVD_NAME)" -k "$(AVD_SYSIMG)" -d "$(AVD_DEVICE)"; \
	fi

# Launches the emulator in the background and waits until it's fully booted
# and ready to receive an install. Safe to re-run - if an emulator/device is
# already connected, this just proceeds straight to the boot-wait check.
avd-start:
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$(ANDROID_SDK_ROOT)/emulator:$$PATH"; \
	if adb devices | grep -q "device$$"; then \
		echo ">> A device/emulator is already connected, skipping launch."; \
	else \
		echo ">> Starting emulator '$(AVD_NAME)' in the background..."; \
		nohup emulator -avd "$(AVD_NAME)" -no-snapshot-load > /tmp/emulator.log 2>&1 & \
		echo ">> Waiting for boot to complete (this can take a minute or two the first time)..."; \
		adb wait-for-device; \
		BOOTED=""; \
		for i in $$(seq 1 60); do \
			BOOTED=$$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r'); \
			if [ "$$BOOTED" = "1" ]; then break; fi; \
			sleep 5; \
		done; \
		if [ "$$BOOTED" = "1" ]; then echo "✅  Emulator booted."; \
		else echo "!! Emulator did not report boot-complete in time — check /tmp/emulator.log"; fi; \
	fi

# One-shot: build the debug APK and install+launch it on whatever emulator
# or physical device is currently connected (starting the emulator first if
# nothing is connected yet). This is the Android equivalent of 'make run-ios'.
run-android: avd-start build-apk
	@export PATH="$(ANDROID_SDK_ROOT)/cmdline-tools/latest/bin:$(ANDROID_SDK_ROOT)/platform-tools:$$PATH"; \
	APK=android/app/build/outputs/apk/debug/app-debug.apk; \
	echo ">> Installing $$APK..."; \
	adb install -r "$$APK"; \
	PKG=$$(grep -m1 'applicationId' android/app/build.gradle | sed -E 's/.*"(.*)".*/\1/'); \
	if [ -z "$$PKG" ]; then PKG="$(APP_ID)"; fi; \
	echo ">> Launching $$PKG..."; \
	adb shell monkey -p "$$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null; \
	echo "✅  App installed and launched on the connected device/emulator."

avd-stop:
	@export PATH="$(ANDROID_SDK_ROOT)/platform-tools:$$PATH"; \
	adb -s $$(adb devices | awk '/emulator/{print $$1; exit}') emu kill 2>/dev/null || echo ">> No running emulator found."

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
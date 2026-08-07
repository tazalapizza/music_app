import Foundation
import Capacitor
import MediaPlayer
import AVFoundation
import os.log

// DIAGNOSTICS: mirrors the role Logcat played in debugging the Android
// native-audio issues earlier in this project - visible in Xcode's own
// console when running from Xcode, and in Console.app (filter by
// subsystem "com.vibing.app", category "SystemVolume") when running a
// Codemagic-built install without Xcode attached. Two specific unknowns
// this is meant to catch, flagged as real uncertainties rather than
// assumed to work, since none of this could be tested without a Mac
// during development:
//   1. Whether self.bridge?.viewController?.view.window exists at the
//      moment load() fires - if not, installHiddenVolumeView() silently
//      returns and volumeSlider stays nil forever.
//   2. Whether MPVolumeView's subviews actually contain a UISlider at the
//      expected position - Apple doesn't document this internal
//      structure, so it's relied upon (like every other library that does
//      this) rather than guaranteed by any API contract.
private let volumeLog = OSLog(subsystem: "com.vibing.app", category: "SystemVolume")

// -----------------------------------------------------------------------
// SystemVolumePlugin.swift — local Capacitor plugin (iOS only).
//
// Mirrors SystemVolumePlugin.java's public JS-facing shape exactly
// (getVolume / setVolume / getMaxSteps / 'volumeChanged' event), so
// system-volume-adapter.js on the web side needs no platform-specific
// branching beyond what it already has for isAndroid() - the same plugin
// NAME ("SystemVolume") is reused here so the existing JS wrapper's
// getPlugin() lookup (window.Capacitor.Plugins.SystemVolume) just works,
// once system-volume-adapter.js's isSupported() check is widened to
// include iOS (see that file's own note on this).
//
// HOW THIS ACTUALLY WORKS (the important part): iOS has NO API to set
// system volume from code, full stop - confirmed via Apple's own developer
// forums (AVAudioSession.outputVolume is read-only; there is no
// setOutputVolume() anywhere). The ONE sanctioned mechanism, used by every
// app that has this feature (Documents, Spotify, Apple Music, etc.), is:
//
//   1. Add an MPVolumeView SOMEWHERE in the view hierarchy - it doesn't
//      need to be visible or positioned correctly, it just needs to exist,
//      because MPVolumeView is what's actually granted the ability to
//      read/write system volume, not any plugin/app code directly.
//   2. Reach into that MPVolumeView's own internal UISlider subview and
//      set ITS .value programmatically - this is what actually moves the
//      real system volume, because the slider IS the live system volume
//      control, just relocated off-screen instead of removed.
//   3. Observe AVAudioSession's outputVolume KVO notification to detect
//      when the value changes for ANY reason (physical buttons, this
//      plugin's own setVolume(), another app if backgrounded, etc.) and
//      forward that as a JS event.
//
// This is deliberately NOT a visible, skinned-to-match-the-UI slider
// overlaid on the web player bar - that would require pixel-perfect
// position syncing between native UIKit coordinates and WebView-rendered
// HTML, which is fragile and was intentionally avoided (see the project's
// iOS volume integration notes for the fuller reasoning). Instead, the
// EXISTING HTML/CSS volume slider in the web UI remains the only visible
// control - this plugin just makes sure it's secretly driving/reflecting
// the real system volume underneath, the same way SystemVolumePlugin.java
// does on Android via AudioManager, just through the very different
// mechanism iOS requires.
// -----------------------------------------------------------------------

@objc(SystemVolumePlugin)
public class SystemVolumePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SystemVolumePlugin"
    public let jsName = "SystemVolume"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMaxSteps", returnType: CAPPluginReturnPromise)
    ]

    private var hiddenVolumeView: MPVolumeView?
    private var volumeSlider: UISlider?
    private var isObserving = false

    // Called once when the plugin is first loaded by the Capacitor bridge -
    // this is where the hidden MPVolumeView gets installed, matching
    // SystemVolumePlugin.java's load() override for the same "set up once"
    // timing.
    public override func load() {
        os_log("load() called - installing hidden MPVolumeView", log: volumeLog, type: .info)
        DispatchQueue.main.async { [weak self] in
            self?.installHiddenVolumeView()
        }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            os_log("AVAudioSession.setActive failed (non-fatal, see comment below): %{public}@", log: volumeLog, type: .default, String(describing: error))
            // Non-fatal: NativeAudioAdapter's own configure() call (see
            // native-audio-adapter.js) already activates a shared audio
            // session for playback: this is a best-effort second attempt,
            // not the only place session activation happens.
        }
        startObservingVolumeChanges()
    }

    private var installRetryCount = 0
    private let maxInstallRetries = 5

    private func installHiddenVolumeView() {
        guard let window = self.bridge?.viewController?.view.window ?? self.bridge?.viewController?.view else {
            if installRetryCount < maxInstallRetries {
                installRetryCount += 1
                os_log("installHiddenVolumeView: no window/view available yet (attempt %{public}d/%{public}d) - retrying in 0.5s", log: volumeLog, type: .default, installRetryCount, maxInstallRetries)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.installHiddenVolumeView()
                }
            } else {
                os_log("installHiddenVolumeView: giving up after %{public}d attempts - volumeSlider will stay nil, setVolume() will reject until the app is relaunched", log: volumeLog, type: .error, maxInstallRetries)
            }
            return
        }
        installRetryCount = 0 // reset in case this is ever called again later (e.g. a future window/scene change) after a prior successful install
        // Positioned at zero size, off in a corner - MPVolumeView doesn't
        // need to be visible or a particular size to function; it just
        // needs to be part of the view hierarchy for the system to treat
        // it as a legitimate volume control host. showsRouteButton is
        // disabled since this instance is never seen, so there's no
        // AirPlay-picker button to worry about (the existing player UI can
        // add its own separate AirPlay/route picker later if desired -
        // unrelated to this specific plugin's scope).
        let volumeView = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
        volumeView.showsRouteButton = false
        volumeView.alpha = 0.0001 // fully transparent but not exactly 0, which some iOS versions have been observed to treat as "not really there" and skip laying out - see the plugin's own integration notes if this needs revisiting
        window.addSubview(volumeView)
        self.hiddenVolumeView = volumeView

        // The actual control is a UISlider living INSIDE the MPVolumeView's
        // subviews - MPVolumeView itself has no direct "set value" API, so
        // this reaches into its subview tree to find the real slider, which
        // is the documented/standard workaround (see this file's own header
        // comment and the ABVolumeControl library referenced in the
        // project's iOS volume integration notes, which uses the same
        // technique).
        self.volumeSlider = volumeView.subviews.first(where: { $0 is UISlider }) as? UISlider

        if self.volumeSlider != nil {
            os_log("installHiddenVolumeView: UISlider found successfully inside MPVolumeView - setVolume() should work", log: volumeLog, type: .info)
        } else {
            os_log("installHiddenVolumeView: NO UISlider found among MPVolumeView's %{public}d subview(s) - this iOS version may have changed MPVolumeView's internal structure. setVolume() will reject until this is fixed. Subview types: %{public}@", log: volumeLog, type: .error, volumeView.subviews.count, volumeView.subviews.map { String(describing: type(of: $0)) }.joined(separator: ", "))
        }
    }

    private func startObservingVolumeChanges() {
        guard !isObserving else { return }
        isObserving = true
        // KVO on AVAudioSession.outputVolume fires for ANY change to
        // system media volume, regardless of source - physical buttons,
        // this plugin's own setVolume() below, Control Center, another
        // app's MPVolumeView if one exists, etc. This mirrors
        // SystemVolumePlugin.java's VOLUME_CHANGED_ACTION broadcast
        // receiver, which serves the identical purpose on Android.
        AVAudioSession.sharedInstance().addObserver(
            self,
            forKeyPath: "outputVolume",
            options: [.new],
            context: nil
        )
    }

    public override func handleOnDestroy() {
        if isObserving {
            AVAudioSession.sharedInstance().removeObserver(self, forKeyPath: "outputVolume")
            isObserving = false
        }
        hiddenVolumeView?.removeFromSuperview()
        super.handleOnDestroy()
    }

    public override func observeValue(
        forKeyPath keyPath: String?,
        of object: Any?,
        change: [NSKeyValueChangeKey: Any]?,
        context: UnsafeMutableRawPointer?
    ) {
        guard keyPath == "outputVolume" else { return }
        let volume = AVAudioSession.sharedInstance().outputVolume
        os_log("outputVolume changed to %{public}f - notifying JS listeners", log: volumeLog, type: .debug, volume)
        notifyListeners("volumeChanged", data: ["volume": Double(volume)])
    }

    // getVolume(): returns 0..1, matching SystemVolumePlugin.java's
    // convention exactly (and NativeAudioAdapter.setVolume's, so JS-side
    // code treats every volume value in this app the same way regardless
    // of which platform/backend produced it).
    @objc func getVolume(_ call: CAPPluginCall) {
        let volume = AVAudioSession.sharedInstance().outputVolume
        call.resolve(["volume": Double(volume)])
    }

    // setVolume({ volume: 0..1 }): moves the hidden slider's value, which
    // is what actually changes the real system volume - see this file's
    // header comment for why this indirection through a slider is the only
    // way to do this on iOS at all.
    @objc func setVolume(_ call: CAPPluginCall) {
        guard let volume = call.getDouble("volume") else {
            call.reject("Missing required 'volume' parameter (expected a number between 0 and 1)")
            return
        }
        let clamped = max(0.0, min(1.0, volume))
        DispatchQueue.main.async { [weak self] in
            guard let slider = self?.volumeSlider else {
                os_log("setVolume(%{public}f) rejected: volumeSlider is nil - see installHiddenVolumeView's log output above for why", log: volumeLog, type: .error, clamped)
                call.reject("System volume control is not ready yet")
                return
            }
            // setValue must run on the main thread (it's a UIKit control) -
            // sendActions is required alongside setValue, since setting
            // .value alone updates the slider's visual state but does NOT
            // itself trigger the underlying system volume change; the
            // slider only actually applies the new value when it receives
            // the .valueChanged action, exactly as if a real finger-drag
            // had produced it.
            slider.setValue(Float(clamped), animated: false)
            slider.sendActions(for: .valueChanged)
            os_log("setVolume(%{public}f) applied via hidden slider", log: volumeLog, type: .info, clamped)
            call.resolve()
        }
    }

    // getMaxSteps(): iOS doesn't expose a fixed step count the way
    // Android's AudioManager does (getStreamMaxVolume) - volume here is a
    // continuous 0..1 float, not N discrete integer steps. Returned as a
    // conventional 16 (the commonly-cited number of physical-button presses
    // from silent to max on most iOS hardware) purely so callers expecting
    // a numeric "steps" field from the shared JS wrapper get a plausible
    // value rather than undefined - not read from any actual API, since
    // none exists. Not currently consumed by controls.js (see that file's
    // own note on this field), so this approximation costs nothing in
    // practice today.
    @objc func getMaxSteps(_ call: CAPPluginCall) {
        call.resolve(["steps": 16])
    }
}
#!/usr/bin/env python3
# scripts/patch-android-manifest.py
#
# Idempotently patches android/app/src/main/AndroidManifest.xml and
# strings.xml with what @mediagrid/capacitor-native-audio requires for
# Android background playback: the AudioPlayerService declaration, three
# permissions, and a string resource the service description references.
#
# Called automatically by `make init` right after `cap add android` (see
# the Makefile's `init` and `android-manifest-patch` targets) - not meant
# to be run standalone in normal use, but safe to re-run on its own too:
# every insertion below checks whether it's already present before adding
# anything, so running this twice, or against a manifest that already has
# these entries for some other reason, won't create duplicates.
#
# Uses Python's xml.etree rather than sed/grep text-splicing - manifest XML
# has enough structural nuance (attribute ordering, self-closing tags,
# nested elements) that regex-based insertion is genuinely fragile here; a
# real XML parser guarantees well-formed output regardless of how the
# existing file happens to be formatted.

import xml.etree.ElementTree as ET
import os

ANDROID_NS = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", ANDROID_NS)

manifest_path = "android/app/src/main/AndroidManifest.xml"
strings_path = "android/app/src/main/res/values/strings.xml"


def qn(tag):
    return "{%s}%s" % (ANDROID_NS, tag)


def main():
    # --- AndroidManifest.xml ---
    tree = ET.parse(manifest_path)
    root = tree.getroot()

    # Permissions: add each one only if an identical <uses-permission> isn't
    # already present (checked by its android:name value, not exact XML
    # text, so this is robust to attribute-order differences).
    required_permissions = [
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
        "android.permission.WAKE_LOCK",
    ]
    existing_permissions = {
        el.get(qn("name")) for el in root.findall("uses-permission")
    }
    changed = False
    for perm in required_permissions:
        if perm not in existing_permissions:
            el = ET.SubElement(root, "uses-permission")
            el.set(qn("name"), perm)
            changed = True
            print(f"  + added permission: {perm}")
        else:
            print(f"  = permission already present: {perm}")

    # Service: add only if a <service> with this exact android:name isn't
    # already present inside <application>.
    application = root.find("application")
    if application is None:
        raise SystemExit(
            "ERROR: <application> tag not found in AndroidManifest.xml - "
            "manifest structure unexpected, patch manually instead."
        )

    service_name = "us.mediagrid.capacitorjs.plugins.nativeaudio.AudioPlayerService"
    existing_services = {
        el.get(qn("name")) for el in application.findall("service")
    }
    if service_name not in existing_services:
        service = ET.SubElement(application, "service")
        service.set(qn("name"), service_name)
        service.set(qn("description"), "@string/audio_player_service_description")
        service.set(qn("foregroundServiceType"), "mediaPlayback")
        service.set(qn("exported"), "true")
        intent_filter = ET.SubElement(service, "intent-filter")
        action = ET.SubElement(intent_filter, "action")
        action.set(qn("name"), "androidx.media3.session.MediaSessionService")
        changed = True
        print(f"  + added service: {service_name}")
    else:
        print(f"  = service already present: {service_name}")

    if changed:
        tree.write(manifest_path, encoding="utf-8", xml_declaration=True)
        print(">> AndroidManifest.xml updated.")
    else:
        print(">> AndroidManifest.xml already up to date, no changes written.")

    # --- strings.xml ---
    os.makedirs(os.path.dirname(strings_path), exist_ok=True)
    if os.path.exists(strings_path):
        stree = ET.parse(strings_path)
        sroot = stree.getroot()
    else:
        sroot = ET.Element("resources")
        stree = ET.ElementTree(sroot)

    existing_string_names = {el.get("name") for el in sroot.findall("string")}
    if "audio_player_service_description" not in existing_string_names:
        s = ET.SubElement(sroot, "string")
        s.set("name", "audio_player_service_description")
        s.text = "Allows for audio to play in the background."
        stree.write(strings_path, encoding="utf-8", xml_declaration=True)
        print("  + added string resource: audio_player_service_description")
    else:
        print("  = string resource already present: audio_player_service_description")


if __name__ == "__main__":
    main()
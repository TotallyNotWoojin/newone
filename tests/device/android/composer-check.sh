#!/bin/zsh
# Kept for muscle memory; the check itself lives in run.sh.
#
# This script used to hardcode emulator-5554 (whichever emulator booted first,
# which with another project's AVD on the machine was sometimes the wrong one),
# assumed the emulator was already up, and minted an emailed CODE for a flow
# that actually reads PASSWORD -- so it typed nothing into the password field.
# run.sh finds the device by AVD name, boots it if needed, and signs in with
# the review account's password. Same arguments: [apk] [shot-dir].
exec "${0:a:h}/run.sh" "$@"

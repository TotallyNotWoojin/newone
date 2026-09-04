#!/bin/zsh
# Seed the suite simulators' Files app ("On My iPhone") with the sample
# documents that media/choose-file.yaml picks. The Files picker opens on an
# empty Recents tab on a fresh simulator; the local File Provider storage is a
# plain directory in the simulator's shared app-group container.
set -e
cd "$(dirname "$0")"
for udid in "$@"; do
  # Several app groups own a "File Provider Storage" folder (iCloud Drive, Photos);
  # "On My iPhone" is the group.com.apple.FileProvider.LocalStorage container.
  dir=""
  for group in ~/Library/Developer/CoreSimulator/Devices/"$udid"/data/Containers/Shared/AppGroup/*/; do
    id=$(/usr/libexec/PlistBuddy -c "Print :MCMMetadataIdentifier" "$group/.com.apple.mobile_container_manager.metadata.plist" 2>/dev/null)
    if [ "$id" = "group.com.apple.FileProvider.LocalStorage" ]; then dir="$group/File Provider Storage"; mkdir -p "$dir"; break; fi
  done
  if [ -z "$dir" ]; then echo "no File Provider Storage on $udid (boot it once and open Files)"; continue; fi
  cp fixtures/newone-sample.pdf fixtures/newone-sample.txt "$dir/"
  echo "seeded $udid"
done

#!/bin/zsh
# Seed the suite simulators' Files app ("On My iPhone") with the sample
# documents that media/choose-file.yaml picks. The Files picker opens on an
# empty Recents tab on a fresh simulator; the local File Provider storage is a
# plain directory in the simulator's shared app-group container.
set -e
cd "$(dirname "$0")"
for udid in "$@"; do
  dir=$(find ~/Library/Developer/CoreSimulator/Devices/"$udid"/data/Containers/Shared/AppGroup -maxdepth 2 -name "File Provider Storage" | head -1)
  if [ -z "$dir" ]; then echo "no File Provider Storage on $udid (boot it once and open Files)"; continue; fi
  cp fixtures/newone-sample.pdf fixtures/newone-sample.txt "$dir/"
  echo "seeded $udid"
done

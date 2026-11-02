#!/bin/sh
# Stamps a new version on every asset URL so phones load the new files right after a deploy
# (GitHub Pages lets browsers keep old copies for up to 10 minutes). Run before each commit.
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M)
sed -i -E "s#(href=\"style\.css)(\?v=[0-9]+)?\"#\1?v=$V\"#; s#(src=\"js/app\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#; s#(<span id=\"version\">)[^<]*#\1$V#" index.html
sed -i -E "s#(from '\./[a-z-]+\.js)(\?v=[0-9]+)?'#\1?v=$V'#g; s#(new URL\('\./solver-worker\.js)(\?v=[0-9]+)?'#\1?v=$V'#" js/*.js
echo "version $V"

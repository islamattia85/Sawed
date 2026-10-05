"""Build the prototype Futures page from analyse.py output.

    python3 scripts/futures/prototype/build.py futures-out/attia-data.json futures-out/attia.html

The page is a design reference for the Futures screen (docs/futures-module.md,
section 5): the average-vs-worst chart, hover and tap details, the battery-life
switch and the table of every system. Not app code.
"""
import sys, os
data_path, out_path = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
html = open(os.path.join(here, 'template.html')).read().replace('__DATA__', open(data_path).read())
open(out_path, 'w').write(html)
print('wrote', out_path)

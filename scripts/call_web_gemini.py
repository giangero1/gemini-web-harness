#!/usr/bin/env python3
"""
Python wrapper for Gemini Web Harness
Calls D:\gemini-web-harness\scripts\call_web_gemini.js
"""

import sys
import subprocess
from pathlib import Path

JS_SCRIPT = Path("D:/gemini-web-harness/scripts/call_web_gemini.js")

def main():
    if not JS_SCRIPT.exists():
        sys.stderr.write(f"Error: {JS_SCRIPT} not found.\n")
        sys.exit(1)
        
    cmd = ["node", str(JS_SCRIPT)] + sys.argv[1:]
    res = subprocess.run(cmd)
    sys.exit(res.returncode)

if __name__ == "__main__":
    main()

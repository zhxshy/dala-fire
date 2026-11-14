"""Run the pipeline end to end: ingest -> clean + grid -> sensor availability -> harmonize -> validate -> web export -> sensitivity."""
import subprocess, sys
from pathlib import Path

for step in ["01_ingest.py", "02_grid.py", "03_availability.py", "04_harmonize.py", "05_validate.py", "06_export_web.py", "07_sensitivity.py"]:
    print(f"\n===== {step} =====", flush=True)
    subprocess.run([sys.executable, str(Path(__file__).parent / "scripts" / step)], check=True)

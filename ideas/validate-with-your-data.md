# Check the sim against your own data

**Status: pinned.** Small, and it keeps the sim honest. Be the editor: the sim's numbers should
be checkable against things you measured.

- **Study B thrust-stand data** (5" prop, g/W vs density altitude at St. George, Cedar City and
  Brian Head). The sim scales prop thrust and motor load with air density. Plot your measured
  thrust and efficiency against the sim's at the same density altitude and see where it's off.
- **ArduPilot dataflash logs** from the Goblin and the 7":
  - replay your sticks through the sim and compare attitude, speed and battery voltage to the
    log
  - fit drag, thrust and battery resistance so the models match your aircraft, not a generic one
- **Betaflight blackbox** from your quads: compare step responses and voltage sag on punch-outs
  with test/quad_test.js.
- A small `test/compare_*.js` per dataset, so every check reruns when the physics changes.

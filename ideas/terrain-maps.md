# Terrain maps from lidar

**Status: pinned.** Independent of the other ideas; can start any time.

- Real terrain from USGS 3DEP or UGRC lidar (1 m or better in much of Utah):
  - Zion
  - Timpanogos
  - Yosemite
  - your local fields around Cedar City and Brian Head
- Decimate to a mesh the Chromebook can draw: tiles with levels of detail, built offline into
  the repo or downloaded as files.
- Orthophoto (NAIP) colours draped over it.
- Field elevation sets density altitude automatically. Pilot position and home are picked on
  the map.
- **Terrain-shaped wind**:
  - flow up windward slopes and down lee slopes
  - rotor behind ridges
  - canyon channelling
  - this is where real mountain SAR flights get into trouble
- Line-of-sight for the link model comes for free from the terrain.

# APRS symbol images

The PNG files in this folder are the **aprs.fi APRS symbol set** by Heikki Hannikainen, OH7LZB:
https://github.com/hessu/aprs-symbols (commit `f2286a9cd43eb6ba4501250b4c39fff111e3796c`, files
`png/aprs-symbols-64-0.png`, `-1.png`, `-2.png`, unchanged).

- `aprs-symbols-64-0.png`: primary table (`/`)
- `aprs-symbols-64-1.png`: alternate table (`\`)
- `aprs-symbols-64-2.png`: overlay characters (0-9, A-Z), drawn on top of an alternate symbol

Each sheet has 16 columns and 6 rows of 64x64 pixel cells. The cell of a symbol code `c` is number
`c - 33` (`!` is the first cell).

The copyright and license of each symbol differs (public domain, CC BY-SA, CC BY, unknown, and a few
brand logos). See [COPYRIGHT.md](COPYRIGHT.md), copied from the same commit. The author asks users of
the set to give a pointer to its source, which the app does under the symbol in Settings.

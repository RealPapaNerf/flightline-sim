# Aircraft files

Aircraft you can load into the sim without building them: open
<https://realpapanerf.github.io/flightline-sim/>, then Settings → Aircraft →
**Aircraft from this site's folder**. Or download a `.json` here and use
**Import aircraft file**, which also works offline and in the installed app.

Each file is JSON and nothing but JSON — a few hundred checked, clamped
numbers. [`docs/aircraft-format.md`](../docs/aircraft-format.md) says what
every one of them means.

## Adding one

1. Build it in Settings → Builder, or write a build sheet with
   [the chat prompt](../docs/design-an-aircraft-prompt.md).
2. Export it, drop the file in this folder, and add a line to `index.json`:

   ```json
   { "file": "my-plane.json", "name": "My plane", "kind": "conventional",
     "blurb": "One sentence for the list." }
   ```

   `file` is the only field the sim needs; the rest is what the list shows
   before anything is loaded.
3. `node test/aircraft_test.js` still has to pass, and the file has to load
   with no errors.

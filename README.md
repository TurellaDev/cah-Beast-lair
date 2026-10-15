# cah-beast-lairs

`cah-beast-lairs` spawns configured wild beast populations when players approach a lair. It uses the server `Beast` API documented at:

https://docs.hogwarts-mp.com/guides/npcs-and-creatures/beasts-and-characters/

This is separate from `hmp-npcs` and from the native `encounters` world policy. `hmp-npcs` only accepts enemy ids; `hmp-beast-lairs` spawns nurturable creatures such as `Mooncalf`, `Niffler`, `Hippogriff`, and their offspring.

## Configuration

Copy `examples/config/data/hmp-beast-lairs.json` to `<server-root>/data/hmp-beast-lairs.json`, then replace the example coordinates with your lair coordinates.

```json
{
  "command": "beastlair",
  "enableCommands": true,
  "adminGroups": [
    { "key": "admin", "minimumGrade": 1 }
  ],
  "enabled": true,
  "tickIntervalMs": 2000,
  "activateRadius": 12000,
  "deactivateRadius": 18000,
  "respawnDelayMs": 30000,
  "maximumBeasts": 256,
  "lairs": [
    {
      "key": "mooncalf-den",
      "enabled": true,
      "position": { "x": 367993, "y": -454811, "z": -81910 },
      "radius": 2500,
      "virtualWorld": 0,
      "beasts": [
        { "species": "Mooncalf", "count": 4, "capturable": true }
      ]
    }
  ]
}
```

### Admin editor UI

`/beastlair` (alias `/lair`) opens a full-screen in-game editor. It is protected by
`hmp-core` admin groups — non-admins get a "no permission" message and never see the UI.

In the editor you can:

- See every configured lair in a sidebar, filterable by name.
- Click **+ New** to start a lair at your feet, or click an existing lair to edit it.
- **Use my position** to fill X/Y/Z and the virtual world from where you are standing.
- Set the spawn `radius`, toggle the lair on/off, and rename the key.
- Add any number of species rows. Species, colour, and gender dropdowns are populated
  from the server's `Beast.catalog()`, so you only pick valid ids.
- Per species: `count`, `capturable`, and optional `scale`, `yaw`, `name`, `gender`, `color`.
- **Save** persists to `data/hmp-beast-lairs.json` and rebuilds the live lair immediately.
- **Delete** removes the lair; **Reload disk** re-reads the config file.

`Ctrl/Cmd+S` saves, `Esc` closes. Read-only text commands remain for quick checks:

```text
/beastlair status
/beastlair list
/beastlair catalog
/beastlair reload
```

### Lair fields

- `key`: unique lair id.
- `enabled`: allows a lair to be disabled without deleting it.
- `position`: world coordinates in centimetres.
- `radius`: random spawn spread around the lair.
- `virtualWorld`: defaults to `0`, the normal world.
- `beasts`: one or more species groups.
  - `species`: species accepted by `Beast.create`.
  - `count`: how many of that species to keep alive.
  - `capturable`: whether the Nab-Sack may catch them.
  - optional `scale`, `yaw`, `name`, `gender`, and `color`.

### Global fields

- `activateRadius`: distance at which the lair becomes active.
- `deactivateRadius`: distance at which all beasts are destroyed; must be at least `activateRadius`.
- `respawnDelayMs`: delay before a captured or missing beast is replaced.
- `maximumBeasts`: global cap for this resource.

## Runtime API

```js
const lairs = Imports.get("hmp-beast-lairs");
lairs.status();
lairs.list();
lairs.catalog();
```

`catalog()` returns `Beast.catalog()` from the server runtime, so you can use it to discover the exact species ids supported by your server build.

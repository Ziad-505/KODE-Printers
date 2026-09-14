-- The unit a supply level is measured in.
--
-- `printer_supplies` stored a level and a maximum and nothing about what either
-- one counts, and the fleet board divided them to get a percentage. That is
-- correct only when the two are the same quantity, and RFC 3805 does not
-- promise they are: `prtMarkerSuppliesSupplyUnit` (43.11.1.1.7) exists
-- precisely because a device may report grams, millilitres, hours, sheets,
-- impressions or percent.
--
-- A Xerox WorkCentre 7835 is the case that exposed it. Its drum cartridges
-- report `percent`, max 100, and the board showed 35% — matching the device's
-- own page exactly. Its toner cartridges report `impressions`: level 260 is
-- *estimated pages remaining* and max 26000 is the cartridge's rated yield.
-- Dividing those gave "1%" against a machine whose own display read "10% —
-- Reorder — 268 pages — 4 days". Two different quantities, one division, and a
-- number on the wall that contradicted the number on the printer.
--
-- With the unit recorded, a percentage is published only where the device
-- reports one, and a count is shown as a count. The ratio is still computed
-- internally for the burn-rate forecast, where it is valid: level and max are
-- on the same scale as each other over time, whatever that scale is.
--
-- Not destructive: one nullable column. Existing rows re-populate on the next
-- status sweep, which runs every fifteen seconds. §B19.5.

ALTER TABLE printer_supplies
  ADD COLUMN IF NOT EXISTS unit TEXT;

COMMENT ON COLUMN printer_supplies.unit IS
  'prtMarkerSuppliesSupplyUnit as a keyword (percent, impressions, sheets, …). '
  'NULL where the device did not say. A percentage is published to clients only '
  'when this is percent-like; otherwise level is a count and is shown as one.';

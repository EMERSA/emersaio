# The mark

`emersa-mark.svg` is the official Emersa mark: the left-pointing chevron with its stem and the eye, taken straight
from the vector master (`Emersa Logo-BDS1-002A.pdf`, the visible "Layer 2" paths, converted from PDF points into a
square viewBox). The master paints the right half of the eye red; one colour is all `currentColor` allows, so the
eye is a solid disc here, as in the mark-only artwork. Any later export must keep these three properties, then
nothing else changes:

- a square `viewBox` (`0 0 100 100` or any square), no `width` or `height` attributes;
- `currentColor` for every fill and stroke, so the mark takes the colour of its context;
- no embedded `<style>`, `<script>` or raster images.

`src/components/LogoSlot.astro` inlines it everywhere (header, footer, 404). `public/favicon.svg` is a separate
copy of the same geometry with the orange baked in, because a favicon has no page context to inherit a colour
from; update it too.

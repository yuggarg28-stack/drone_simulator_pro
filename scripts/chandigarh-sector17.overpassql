[out:json][timeout:65];
(
  way["building"](30.73665,76.77835,30.74349,76.78683);
  way["highway"~"^(primary|secondary|tertiary|residential|service|unclassified|living_street|pedestrian|footway|path|cycleway|trunk)$"](30.73665,76.77835,30.74349,76.78683);
);
out geom;

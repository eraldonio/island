// The model gallery: low-poly voxel prefabs (a tree, a house, a duck, ...)
// that can be stamped into the world like a block. A model is just a list of
// model-local voxels whose origin is the min corner; the two helpers below
// size one up and place it, centred, on a clicked world column.

// Palette ids: 0 grass, 1 dirt, 2 stone, 3 sand, 4 wood, 5 brick,
//              6 snow, 7 slate, 8 leaf.

export const MODELS = [
  {
    id: 'tree',
    name: 'Tree',
    voxels: [
      // root flare
      [1, 1, 0, 4], [0, 1, 0, 4], [2, 1, 0, 4], [1, 0, 0, 4], [1, 2, 0, 4],
      // trunk
      [1, 1, 1, 4], [1, 1, 2, 4],
      // rounded canopy
      [0, 0, 3, 8], [1, 0, 3, 8], [2, 0, 3, 8],
      [0, 1, 3, 8], [1, 1, 3, 8], [2, 1, 3, 8],
      [0, 2, 3, 8], [1, 2, 3, 8], [2, 2, 3, 8],
      [1, 0, 4, 8], [0, 1, 4, 8], [1, 1, 4, 8], [2, 1, 4, 8], [1, 2, 4, 8],
    ],
  },
  {
    id: 'pine',
    name: 'Pine',
    voxels: [
      // rooted base and tapering needle tiers
      [1, 1, 0, 4], [0, 1, 0, 4], [2, 1, 0, 4], [1, 0, 0, 4], [1, 2, 0, 4],
      [1, 1, 1, 8], [0, 1, 1, 8], [2, 1, 1, 8], [1, 0, 1, 8], [1, 2, 1, 8],
      [1, 1, 2, 8],
      [1, 1, 3, 8],
    ],
  },
  {
    id: 'bush',
    name: 'Bush',
    voxels: [
      [1, 1, 0, 4], [0, 1, 0, 8], [2, 1, 0, 8], [1, 0, 0, 8], [1, 2, 0, 8],
      [1, 1, 1, 8], [0, 1, 1, 8], [2, 1, 1, 8], [1, 0, 1, 8], [1, 2, 1, 8],
    ],
  },
  {
    id: 'house',
    name: 'House',
    voxels: [
      // brick walls with a two-high door gap on the front (y = 0)
      [0, 0, 0, 5], [2, 0, 0, 5], [0, 1, 0, 5], [2, 1, 0, 5],
      [0, 2, 0, 5], [1, 2, 0, 5], [2, 2, 0, 5], [1, 1, 0, 4],
      [0, 0, 1, 5], [2, 0, 1, 5], [0, 1, 1, 5], [2, 1, 1, 5],
      [0, 2, 1, 5], [1, 2, 1, 5], [2, 2, 1, 5],
      // slate roof and apex
      [0, 0, 2, 7], [1, 0, 2, 7], [2, 0, 2, 7],
      [0, 1, 2, 7], [1, 1, 2, 7], [2, 1, 2, 7],
      [0, 2, 2, 7], [1, 2, 2, 7], [2, 2, 2, 7],
      [1, 1, 3, 7],
    ],
  },
  {
    id: 'duck',
    name: 'Duck',
    voxels: [
      [0, 1, 0, 6], [1, 1, 0, 6], [2, 1, 0, 6],
      [0, 1, 1, 6], [1, 1, 1, 6], [2, 1, 1, 6],
      [0, 1, 2, 6],
      [0, 0, 2, 3],
    ],
  },
  {
    id: 'boat',
    name: 'Boat',
    voxels: [
      // hull, raised bow and stern, mast, sail
      [0, 0, 0, 4], [1, 0, 0, 4], [2, 0, 0, 4],
      [0, 0, 1, 4], [1, 0, 1, 4], [2, 0, 1, 4],
      [1, 0, 2, 4], [0, 0, 2, 6],
      [1, 0, 3, 4], [0, 0, 3, 6],
    ],
  },
  {
    id: 'boulder',
    name: 'Boulder',
    voxels: [
      [0, 1, 0, 2], [1, 0, 0, 2], [1, 1, 0, 2], [1, 2, 0, 2], [2, 1, 0, 2],
      [0, 1, 1, 2], [1, 0, 1, 2], [1, 1, 1, 2], [1, 2, 1, 2], [2, 1, 1, 2],
      [1, 1, 2, 0],
    ],
  },
  {
    id: 'cactus',
    name: 'Cactus',
    voxels: [
      [1, 1, 0, 8], [0, 1, 0, 3], [2, 1, 0, 3], [1, 0, 0, 3], [1, 2, 0, 3],
      [1, 1, 1, 8],
      [1, 1, 2, 8], [0, 1, 2, 8], [2, 1, 2, 8],
      [1, 1, 3, 8], [0, 1, 3, 8],
    ],
  },
  {
    id: 'well',
    name: 'Well',
    voxels: [
      // stone rim, four wooden posts, slate canopy
      [0, 0, 0, 2], [1, 0, 0, 2], [2, 0, 0, 2],
      [0, 1, 0, 2], [2, 1, 0, 2],
      [0, 2, 0, 2], [1, 2, 0, 2], [2, 2, 0, 2],
      [0, 0, 1, 4], [2, 0, 1, 4], [0, 2, 1, 4], [2, 2, 1, 4],
      [0, 0, 2, 7], [1, 0, 2, 7], [2, 0, 2, 7],
      [0, 1, 2, 7], [1, 1, 2, 7], [2, 1, 2, 7],
      [0, 2, 2, 7], [1, 2, 2, 7], [2, 2, 2, 7],
    ],
  },
  {
    id: 'campfire',
    name: 'Campfire',
    voxels: [
      // crossed logs inside a stone ring, with a small flame
      [1, 0, 0, 4], [0, 1, 0, 4], [1, 1, 0, 4], [2, 1, 0, 4], [1, 2, 0, 4],
      [0, 0, 0, 2], [2, 0, 0, 2], [0, 2, 0, 2], [2, 2, 0, 2],
      [1, 1, 1, 5],
      [1, 1, 2, 5],
    ],
  },
  {
    id: 'mushroom',
    name: 'Mushroom',
    voxels: [
      // stem on a dirt mound, spotted red cap
      [1, 1, 0, 6], [0, 1, 0, 1], [2, 1, 0, 1], [1, 0, 0, 1], [1, 2, 0, 1],
      [1, 1, 1, 6],
      [1, 1, 2, 5], [0, 1, 2, 5], [2, 1, 2, 5], [1, 0, 2, 6], [1, 2, 2, 6],
    ],
  },
  {
    id: 'snowman',
    name: 'Snowman',
    voxels: [
      [1, 1, 0, 6], [0, 1, 0, 6], [2, 1, 0, 6], [1, 0, 0, 6], [1, 2, 0, 6],
      [1, 1, 1, 6], [0, 1, 1, 4], [2, 1, 1, 4],
      [1, 1, 2, 6],
      [1, 1, 3, 6], [0, 1, 3, 7], [1, 0, 3, 3],
    ],
  },
  {
    id: 'ruins',
    name: 'Ruins',
    voxels: [
      // two stone pillars joined by a mossy lintel, plus rubble
      [0, 0, 0, 2], [2, 0, 0, 2], [1, 0, 0, 2],
      [0, 0, 1, 2], [2, 0, 1, 2],
      [0, 0, 2, 2], [2, 0, 2, 2],
      [0, 0, 3, 2], [2, 0, 3, 2], [1, 0, 3, 0],
    ],
  },
];

/** Footprint of a model in blocks: width and depth of its local grid. */
export function modelSize(model) {
  let w = 0;
  let h = 0;
  for (const [x, y] of model.voxels) {
    if (x + 1 > w) w = x + 1;
    if (y + 1 > h) h = y + 1;
  }
  return { w, h };
}

/**
 * The model's voxels in absolute world cells, footprint centred on the
 * clicked column and resting on `baseZ`.
 * @returns {{x:number,y:number,z:number,mat:number}[]}
 */
export function modelCells(model, cx, cy, baseZ) {
  const { w, h } = modelSize(model);
  const x0 = cx - ((w - 1) >> 1);
  const y0 = cy - ((h - 1) >> 1);
  return model.voxels.map(([x, y, z, mat]) => ({
    x: x0 + x,
    y: y0 + y,
    z: baseZ + z,
    mat,
  }));
}

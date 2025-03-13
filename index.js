import { readdir, stat, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHmac, hash } from 'node:crypto';

import { Jimp } from "jimp";

const RGBA_TO_STATE = {
  "65:64:64:255": '0', // nothing
  "0:0:0:255": '1', // wall
  "255:0:0:255": '2', // path
  '255:255:255:255': '3', // start point
}
const STATE_TO_RGBA = Object.fromEntries(
  Object.entries(RGBA_TO_STATE).map(([k, v]) => [v, k])
);
const rgbaToState = rgba => {
  const pixelString = rgba.map(i => i.toString()).join(':');
  const state = RGBA_TO_STATE[pixelString];
  if (state === undefined) throw `Unknown pixel ${pixelString}`;
  return state;
}
const stateToRgba = state => {
  const pixelString = STATE_TO_RGBA[state];
  if (pixelString === undefined) throw `Unknown state ${state}`;
  return pixelString.split(':').map(i => parseInt(i));
}

const recursiveList = async (targetDir) => {
  const fileList = [];
  let dirList = [targetDir];

  while (dirList.length > 0) {
    dirList = (await Promise.all(dirList.map(async (dir, index) => {
      const paths = await readdir(dir);
      return (await Promise.all(paths.map(async relativePath => {
        const path = resolve(dir, relativePath);
        const stats = await stat(path);
        if (stats.isDirectory()) {
          return path;
        }
        fileList.push(path);
        return null;
      }))).filter(path => path !== null);
    }))).reduce((acc, value) => acc.concat(value), []);
  }

  return fileList;
};

const createHash = (input) => {
  const secret = 'abcdefg';

  return createHmac('sha256', secret)
    .update(input)
    .digest('hex')
    .slice(0, 8);
};

const readComponent = async (path) => {
  const imageFile = await Jimp.read(path);
  const rgbaArray = Array.from(imageFile.bitmap.data);
  const pixels = [];

  const RGBA_SIZE = 4;
  for (let i = 0; i < rgbaArray.length; i += RGBA_SIZE) {
    const pixelArray = rgbaArray.slice(i, i + RGBA_SIZE);
    const pixelString = pixelArray.map(i => i.toString()).join(':');
    switch (pixelString) {
      case "65:64:64:255":
        pixels.push('0'); // nothing
        break;
      case "0:0:0:255":
        pixels.push('1'); // wall
        break;
      case "255:0:0:255":
        pixels.push('2'); // path
        break;
      case '255:255:255:255':
        pixels.push('3'); // start point
        break;
      default:
        throw `Unknown pixel ${pixelString}`;
    }
  }

  return pixels;
};

// const EMPTY_TILE_HASH = 'f2d675f2b325bf00d8dc67902aacdd66e4357f03bc41e5f7c9afa317e56c33f0';
const EMPTY_TILE_HASH = 'f2d675f2';

// Reading maps *********************************
const MAP_HEIGHT_IN_TILES = 7;
const MAP_WIDTH_IN_TILES = 5;
const TILE_HEIGHT_IN_PIXELS = 4;
const TILE_WIDTH_IN_PIXELS = 8;

const MAP_WIDTH_IN_PIXELS = TILE_WIDTH_IN_PIXELS * MAP_WIDTH_IN_TILES;

const TILES_PER_MAP = MAP_HEIGHT_IN_TILES * MAP_WIDTH_IN_TILES;

const readMap = async (path) => {
  const mapPixels = await readComponent(path);
  const mapParsed = [];

  for (let i = 0; i < MAP_HEIGHT_IN_TILES; i++) {
    const tileRow = [];
    for (let j = 0; j < MAP_WIDTH_IN_TILES; j++) {
      const topLeftTilePixelIndex = (i * MAP_WIDTH_IN_PIXELS * TILE_HEIGHT_IN_PIXELS) + (j * TILE_WIDTH_IN_PIXELS);
      const tilePixels = [];
      for (let a = 0; a < TILE_HEIGHT_IN_PIXELS; a++) {
        let pixelRow = [];
        for (let b = 0; b < TILE_WIDTH_IN_PIXELS; b++) {
          const pixelIndex = topLeftTilePixelIndex + (a * MAP_WIDTH_IN_PIXELS) + b;
          const pixel = mapPixels[pixelIndex];
          pixelRow.push(pixel);
        }
        tilePixels.push(pixelRow);
      }
      tileRow.push(tilePixels);
    }
    mapParsed.push(tileRow);
  }

  return mapParsed;
}

const flat = (source, level = 1) => {
  let cursor = source;
  for (let i = 0; i < level; i++) {
    cursor = cursor.reduce((acc, a) => acc.concat(a), []);
  }
  return cursor;
};

// Read maps ************************************
const allMapPaths = await recursiveList('./maps');
const maps = await Promise.all(allMapPaths.map(path => readMap(path)));
const tiles = flat(maps, 2);
// **********************************************

// Extract unique tiles *************************
const hashAndTileList = tiles.map(tile => {
  const pixels = flat(tile, 2);
  const hash = createHash(pixels.join(''));
  return [hash, tile];
});
const tilesDict = Object.fromEntries(hashAndTileList);
// **********************************************

// Count unique tiles required ******************
const hashCount = Object.fromEntries(Object.entries(tilesDict).map(([hash, _pixels]) => [hash, 0]));
const hashCounts = maps.map(() =>
  Object.fromEntries(Object.entries(tilesDict).map(([hash, _pixels]) => [hash, 0]))
);
console.log(hashAndTileList.length);
hashAndTileList.forEach(([hash, _tile], i) => {
  const q = Math.floor( i / TILES_PER_MAP);
  hashCounts[q][hash]++
});
Object.entries(tilesDict).forEach(([hash, _]) => {
  hashCount[hash] = Math.max(...hashCounts.map(counter => counter[hash]));
});

let printCount = Object.entries(hashCount)
  .filter(([hash, _]) => hash !== EMPTY_TILE_HASH)
  .sort((a, b) => b[1] - a[1])
  .map(([hash, count]) => `${hash}: ${count}`).join('\n');
const totalTiles = Object.entries(hashCount)
  .filter(([hash, _]) => hash !== EMPTY_TILE_HASH)
  .reduce((acc, [_, count]) => acc + count, 0);
printCount = `total: ${totalTiles}\n\n` + printCount
writeFile('./output/tile-count.txt', printCount);
// **********************************************

// Export unique tiles *************************
Object.entries(tilesDict).map(async ([tileHash, tileMatrix]) => {
  if (tileHash === EMPTY_TILE_HASH) return;
  const image = new Jimp({ width: tileMatrix[0].length, height: tileMatrix.length, color: 0x000000 });

  tileMatrix.forEach((tileRow, j) => {
    tileRow.forEach((pixelState, i) => {
      const pixelRgba = stateToRgba(pixelState);
      const hexColor = (pixelRgba[0] * (2 ** 24)) + (pixelRgba[1] * (2 ** 16)) + (pixelRgba[2] * (2 ** 8)) + pixelRgba[3];
      image.setPixelColor(hexColor, i, j);
    });
  });
  await image.write(`./output/unique-tiles/${tileHash}.png`);
});
// **********************************************

// Export unique tiles x100 *********************
const SCALE_X_TIMES = 100;
Object.entries(tilesDict).map(async ([tileHash, tileMatrix]) => {
  if (tileHash === EMPTY_TILE_HASH) return;
  const image = new Jimp({
    width: tileMatrix[0].length * SCALE_X_TIMES,
    height: tileMatrix.length * SCALE_X_TIMES,
    color: 0x000000
  });

  tileMatrix.forEach((tileRow, j) => {
    tileRow.forEach((pixelState, i) => {
      const pixelRgba = stateToRgba(pixelState);
      const hexColor = (pixelRgba[0] * (2 ** 24)) + (pixelRgba[1] * (2 ** 16)) + (pixelRgba[2] * (2 ** 8)) + pixelRgba[3];

      for (let a = 0; a < SCALE_X_TIMES; a++) {
        for (let b = 0; b < SCALE_X_TIMES; b++) {
          const x = i * SCALE_X_TIMES + a;
          const y = j * SCALE_X_TIMES + b;
          image.setPixelColor(hexColor, x, y);
        }
      }
    });
  });
  await image.write(`./output/unique-tilesx100/${tileHash}.png`);
});
// **********************************************

// **********************************************

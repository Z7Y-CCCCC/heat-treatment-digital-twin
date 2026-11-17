'use strict';
// Measured on identical offline payloads; every normal build/repack uses this.
const os=require('node:os');
const DEFAULT_MAIN_LEVEL='2';
function collectorCompressionArgs(parallelism=os.availableParallelism?.()||os.cpus().length) {
  const threads=Math.max(1,Math.min(8,Number.isInteger(parallelism)?parallelism:1));
  return ['-mx=3',`-mmt=${threads}`];
}
module.exports={DEFAULT_MAIN_LEVEL,collectorCompressionArgs};

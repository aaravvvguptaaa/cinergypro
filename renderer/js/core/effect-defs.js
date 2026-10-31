// Declarative definitions of every video effect, audio effect and transition.
// Rendering lives in engine/shaders.js (video) and engine/audio-effects.js (audio).
import { uid, deepClone } from './util.js';

const n = (name, label, def, min, max, step = 0.1, extra = {}) => ({ name, label, type: 'number', default: def, min, max, step, ...extra });
const ang = (name, label, def = 0) => ({ name, label, type: 'angle', default: def });
const col = (name, label, def = '#ffffff') => ({ name, label, type: 'color', default: def });
const pt = (name, label, def = [0.5, 0.5]) => ({ name, label, type: 'point', default: def }); // normalized 0..1
const bool = (name, label, def = false) => ({ name, label, type: 'bool', default: def });
const sel = (name, label, options, def) => ({ name, label, type: 'select', options, default: def ?? options[0][0] });
const txt = (name, label, def = '') => ({ name, label, type: 'text', default: def });
const trk = (name, label) => ({ name, label, type: 'track', default: 0 });

export const VIDEO_EFFECTS = {
  // ---- Intrinsics (always present on visual clips) ----
  motion: { name: 'Motion', category: 'Intrinsic', intrinsic: true, params: [
    { name: 'position', label: 'Position', type: 'point', default: [0.5, 0.5], spatial: true },
    n('scale', 'Scale', 100, 0, 10000, 0.1), n('scaleWidth', 'Scale Width', 100, 0, 10000, 0.1),
    bool('uniform', 'Uniform Scale', true), n('rotation', 'Rotation', 0, -36000, 36000, 0.1, { unit: 'deg' }),
    { name: 'anchor', label: 'Anchor Point', type: 'point', default: [0.5, 0.5] }, n('antiFlicker', 'Anti-flicker Filter', 0, 0, 1, 0.01),
    n('cropLeft', 'Crop Left', 0, 0, 100, 0.1, { unit: '%' }), n('cropTop', 'Crop Top', 0, 0, 100), n('cropRight', 'Crop Right', 0, 0, 100), n('cropBottom', 'Crop Bottom', 0, 0, 100),
    bool('flipH', 'Flip Horizontal', false), bool('flipV', 'Flip Vertical', false),
  ] },
  opacity: { name: 'Opacity', category: 'Intrinsic', intrinsic: true, masks: true, params: [
    n('opacity', 'Opacity', 100, 0, 100, 0.1, { unit: '%' }),
    sel('blendMode', 'Blend Mode', [['normal', 'Normal'], ['dissolve', 'Dissolve'], ['darken', 'Darken'], ['multiply', 'Multiply'], ['colorBurn', 'Color Burn'], ['linearBurn', 'Linear Burn'], ['darkerColor', 'Darker Color'],
      ['lighten', 'Lighten'], ['screen', 'Screen'], ['colorDodge', 'Color Dodge'], ['add', 'Linear Dodge (Add)'], ['lighterColor', 'Lighter Color'], ['overlay', 'Overlay'], ['softLight', 'Soft Light'],
      ['hardLight', 'Hard Light'], ['vividLight', 'Vivid Light'], ['linearLight', 'Linear Light'], ['pinLight', 'Pin Light'], ['hardMix', 'Hard Mix'], ['difference', 'Difference'], ['exclusion', 'Exclusion'],
      ['subtract', 'Subtract'], ['divide', 'Divide'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']]),
  ] },
  timeremap: { name: 'Time Remapping', category: 'Intrinsic', intrinsic: true, params: [n('speed', 'Speed', 100, -1000, 1000, 0.1, { unit: '%' })] },

  // ---- Color ----
  lumetri: { name: 'Lumetri Color', category: 'Color Correction', masks: true, params: [
    sel('inputLut', 'Input LUT', [['none', 'None'], ['slog3', 'Sony S-Log3 to Rec.709'], ['clog3', 'Canon C-Log3 to Rec.709'], ['vlog', 'Panasonic V-Log to Rec.709'], ['logc3', 'ARRI LogC3 to Rec.709'], ['logc4', 'ARRI LogC4 to Rec.709'], ['nlog', 'Nikon N-Log to Rec.709'], ['flog', 'Fujifilm F-Log to Rec.709'], ['dlog', 'DJI D-Log to Rec.709'], ['hlg', 'HLG to Rec.709'], ['pq', 'PQ (HDR10) to Rec.709']]),
    n('temperature', 'Temperature', 0, -100, 100, 0.1), n('tint', 'Tint', 0, -100, 100, 0.1), n('exposure', 'Exposure', 0, -5, 5, 0.01),
    n('contrast', 'Contrast', 0, -100, 100, 0.1), n('highlights', 'Highlights', 0, -100, 100, 0.1), n('shadows', 'Shadows', 0, -100, 100, 0.1),
    n('whites', 'Whites', 0, -100, 100, 0.1), n('blacks', 'Blacks', 0, -100, 100, 0.1), n('saturation', 'Saturation', 100, 0, 200, 0.1),
    n('vibrance', 'Vibrance', 0, -100, 100, 0.1),
    { name: 'look', label: 'Look', type: 'lut', default: '' }, n('lookIntensity', 'Look Intensity', 100, 0, 200, 0.1),
    n('faded', 'Faded Film', 0, 0, 100, 0.1), n('sharpen', 'Sharpen', 0, -100, 100, 0.1),
    col('shadowTint', 'Shadow Tint', '#808080'), col('highlightTint', 'Highlight Tint', '#808080'), n('tintBalance', 'Tint Balance', 0, -100, 100, 0.1),
    { name: 'curves', label: 'RGB Curves', type: 'curves', default: { master: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } },
    { name: 'hueCurves', label: 'Hue Saturation Curves', type: 'huecurves', default: { hueSat: [], hueHue: [], hueLuma: [], lumaSat: [], satSat: [] } },
    { name: 'wheels', label: 'Color Wheels', type: 'wheels', default: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] } },
    n('hslEnabled', 'HSL Secondary', 0, 0, 1, 1), { name: 'hslKey', label: 'HSL Key', type: 'hslkey', default: { h: [0.0, 0.1, 0.05], s: [0.2, 1.0, 0.1], l: [0.1, 0.9, 0.1], denoise: 0, blur: 0, invert: false, showMask: false } },
    n('hslTemp', 'Secondary Temperature', 0, -100, 100), n('hslTint', 'Secondary Tint', 0, -100, 100), n('hslContrast', 'Secondary Contrast', 0, -100, 100),
    n('hslSharpen', 'Secondary Sharpen', 0, -100, 100), n('hslSaturation', 'Secondary Saturation', 100, 0, 200), { name: 'hslWheel', label: 'Secondary Correction', type: 'wheel', default: [0, 0, 0] },
    n('vignetteAmount', 'Vignette Amount', 0, -5, 5, 0.01), n('vignetteMidpoint', 'Vignette Midpoint', 50, 0, 100), n('vignetteRoundness', 'Vignette Roundness', 0, -100, 100), n('vignetteFeather', 'Vignette Feather', 50, 0, 100),
  ] },
  brightness_contrast: { name: 'Brightness & Contrast', category: 'Color Correction', masks: true, params: [n('brightness', 'Brightness', 0, -100, 100), n('contrast', 'Contrast', 0, -100, 100)] },
  color_balance: { name: 'Color Balance', category: 'Color Correction', masks: true, params: [
    n('sr', 'Shadow Red', 0, -100, 100), n('sg', 'Shadow Green', 0, -100, 100), n('sb', 'Shadow Blue', 0, -100, 100),
    n('mr', 'Midtone Red', 0, -100, 100), n('mg', 'Midtone Green', 0, -100, 100), n('mb', 'Midtone Blue', 0, -100, 100),
    n('hr', 'Highlight Red', 0, -100, 100), n('hg', 'Highlight Green', 0, -100, 100), n('hb', 'Highlight Blue', 0, -100, 100), bool('preserveLum', 'Preserve Luminosity', true)] },
  levels: { name: 'Levels', category: 'Color Correction', masks: true, params: [n('inBlack', 'Input Black', 0, 0, 255, 1), n('inWhite', 'Input White', 255, 0, 255, 1), n('gamma', 'Gamma', 1, 0.1, 10, 0.01), n('outBlack', 'Output Black', 0, 0, 255, 1), n('outWhite', 'Output White', 255, 0, 255, 1)] },
  tint: { name: 'Tint', category: 'Color Correction', masks: true, params: [col('black', 'Map Black To', '#000000'), col('white', 'Map White To', '#ffffff'), n('amount', 'Amount to Tint', 100, 0, 100)] },
  change_to_color: { name: 'Change to Color', category: 'Color Correction', masks: true, params: [col('from', 'From', '#ff0000'), col('to', 'To', '#0000ff'), n('tolerance', 'Tolerance', 15, 0, 100), n('softness', 'Softness', 5, 0, 100), sel('change', 'Change', [['hue', 'Hue'], ['hs', 'Hue & Saturation'], ['hsl', 'Hue, Lightness & Saturation']], 'hue')] },
  leave_color: { name: 'Leave Color', category: 'Color Correction', masks: true, params: [col('color', 'Color to Leave', '#ff0000'), n('amount', 'Amount to Decolor', 100, 0, 100), n('tolerance', 'Tolerance', 20, 0, 100), n('softness', 'Edge Softness', 10, 0, 100)] },
  channel_mixer: { name: 'Channel Mixer', category: 'Channel', masks: true, params: [
    n('rr', 'Red-Red', 100, -200, 200), n('rg', 'Red-Green', 0, -200, 200), n('rb', 'Red-Blue', 0, -200, 200), n('rc', 'Red-Const', 0, -200, 200),
    n('gr', 'Green-Red', 0, -200, 200), n('gg', 'Green-Green', 100, -200, 200), n('gb', 'Green-Blue', 0, -200, 200), n('gc', 'Green-Const', 0, -200, 200),
    n('br', 'Blue-Red', 0, -200, 200), n('bg', 'Blue-Green', 0, -200, 200), n('bb', 'Blue-Blue', 100, -200, 200), n('bc', 'Blue-Const', 0, -200, 200), bool('mono', 'Monochrome', false)] },
  invert: { name: 'Invert', category: 'Channel', masks: true, params: [sel('channel', 'Channel', [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['a', 'Alpha'], ['luma', 'Luminance']]), n('blend', 'Blend With Original', 0, 0, 100)] },
  black_white: { name: 'Black & White', category: 'Image Control', masks: true, params: [] },
  gamma: { name: 'Gamma Correction', category: 'Image Control', masks: true, params: [n('gamma', 'Gamma', 10, 1, 28, 1)] },
  video_limiter: { name: 'Video Limiter', category: 'Color Correction', params: [n('min', 'Signal Min', 0, 0, 100), n('max', 'Signal Max', 100, 0, 120), sel('axis', 'Reduction Axis', [['luma', 'Luma'], ['chroma', 'Chroma'], ['both', 'Luma and Chroma']], 'both')] },
  lut: { name: 'Apply LUT', category: 'Color Correction', masks: true, params: [{ name: 'file', label: 'LUT', type: 'lut', default: '' }, n('intensity', 'Intensity', 100, 0, 100)] },

  // ---- Blur & Sharpen ----
  gaussian_blur: { name: 'Gaussian Blur', category: 'Blur & Sharpen', masks: true, params: [n('blurriness', 'Blurriness', 10, 0, 500), sel('dimensions', 'Blur Dimensions', [['both', 'Horizontal and Vertical'], ['h', 'Horizontal'], ['v', 'Vertical']]), bool('repeatEdges', 'Repeat Edge Pixels', true)] },
  directional_blur: { name: 'Directional Blur', category: 'Blur & Sharpen', masks: true, params: [ang('direction', 'Direction', 0), n('length', 'Blur Length', 10, 0, 500)] },
  radial_blur: { name: 'Radial Blur', category: 'Blur & Sharpen', masks: true, params: [n('amount', 'Amount', 10, 0, 100), pt('center', 'Center'), sel('type', 'Type', [['zoom', 'Zoom'], ['spin', 'Spin']])] },
  sharpen: { name: 'Sharpen', category: 'Blur & Sharpen', masks: true, params: [n('amount', 'Sharpen Amount', 25, 0, 500)] },
  unsharp_mask: { name: 'Unsharp Mask', category: 'Blur & Sharpen', masks: true, params: [n('amount', 'Amount', 50, 0, 500), n('radius', 'Radius', 1, 0.1, 50), n('threshold', 'Threshold', 0, 0, 255, 1)] },
  camera_blur: { name: 'Camera Blur', category: 'Blur & Sharpen', masks: true, params: [n('percent', 'Percent Blur', 10, 0, 100)] },

  // ---- Distort ----
  lens_distortion: { name: 'Lens Distortion', category: 'Distort', params: [n('curvature', 'Curvature', 0, -100, 100), n('vDecenter', 'Vertical Decentering', 0, -100, 100), n('hDecenter', 'Horizontal Decentering', 0, -100, 100), bool('fill', 'Fill Alpha', false)] },
  twirl: { name: 'Twirl', category: 'Distort', masks: true, params: [ang('angle', 'Angle', 90), n('radius', 'Twirl Radius', 30, 0, 100), pt('center', 'Twirl Center')] },
  wave_warp: { name: 'Wave Warp', category: 'Distort', params: [sel('wave', 'Wave Type', [['sine', 'Sine'], ['square', 'Square'], ['triangle', 'Triangle'], ['sawtooth', 'Sawtooth']]), n('height', 'Wave Height', 10, 0, 500), n('width', 'Wave Width', 40, 1, 1000), ang('direction', 'Direction', 90), n('speed', 'Wave Speed', 1, -10, 10, 0.01)] },
  spherize: { name: 'Spherize', category: 'Distort', masks: true, params: [n('radius', 'Radius', 30, 0, 100), pt('center', 'Center'), n('amount', 'Amount', 50, -100, 100)] },
  mirror: { name: 'Mirror', category: 'Distort', params: [pt('center', 'Reflection Center'), ang('angle', 'Reflection Angle', 0)] },
  offset: { name: 'Offset', category: 'Distort', params: [{ name: 'shift', label: 'Shift Center To', type: 'point', default: [0.5, 0.5] }, n('blend', 'Blend With Original', 0, 0, 100)] },
  corner_pin: { name: 'Corner Pin', category: 'Distort', params: [{ name: 'ul', label: 'Upper Left', type: 'point', default: [0, 0] }, { name: 'ur', label: 'Upper Right', type: 'point', default: [1, 0] }, { name: 'll', label: 'Lower Left', type: 'point', default: [0, 1] }, { name: 'lr', label: 'Lower Right', type: 'point', default: [1, 1] }] },
  transform: { name: 'Transform', category: 'Distort', params: [{ name: 'anchor', label: 'Anchor Point', type: 'point', default: [0.5, 0.5] }, { name: 'position', label: 'Position', type: 'point', default: [0.5, 0.5] }, n('scale', 'Scale', 100, 0, 10000), n('skew', 'Skew', 0, -70, 70), ang('skewAxis', 'Skew Axis', 0), ang('rotation', 'Rotation', 0), n('opacity', 'Opacity', 100, 0, 100), n('shutter', 'Shutter Angle', 0, 0, 360, 1)] },
  magnify: { name: 'Magnify', category: 'Distort', params: [sel('shape', 'Shape', [['circle', 'Circle'], ['square', 'Square']]), pt('center', 'Center'), n('magnification', 'Magnification', 200, 100, 600), n('size', 'Size', 20, 1, 100), n('feather', 'Feather', 2, 0, 50), n('opacity', 'Opacity', 100, 0, 100), bool('ring', 'Ring', true), col('ringColor', 'Ring Color', '#ffffff')] },
  warp_stabilizer: { name: 'Warp Stabilizer', category: 'Distort', analysis: 'stabilize', params: [sel('method', 'Method', [['vidstab', 'Subspace Warp (vid.stab)'], ['deshake', 'Position (Deshake)']]), n('smoothness', 'Smoothness', 15, 1, 100, 1), n('shakiness', 'Shakiness Detection', 6, 1, 10, 1), sel('framing', 'Framing', [['black', 'Stabilize Only'], ['keep', 'Stabilize, Synthesize Edges'], ['zoom', 'Stabilize, Crop, Auto-scale']]), n('additionalScale', 'Additional Scale', 100, 50, 200)] },
  rolling_shutter: { name: 'Rolling Shutter Repair', category: 'Distort', params: [n('amount', 'Rolling Shutter Rate', 0, -100, 100), sel('direction', 'Scan Direction', [['tb', 'Top to Bottom'], ['bt', 'Bottom to Top']])] },

  // ---- Generate ----
  ramp: { name: 'Gradient Ramp', category: 'Generate', masks: true, params: [pt('start', 'Start of Ramp', [0.5, 0]), col('startColor', 'Start Color', '#000000'), pt('end', 'End of Ramp', [0.5, 1]), col('endColor', 'End Color', '#ffffff'), sel('shape', 'Ramp Shape', [['linear', 'Linear'], ['radial', 'Radial']]), n('blend', 'Blend With Original', 0, 0, 100)] },
  four_color_gradient: { name: '4-Color Gradient', category: 'Generate', masks: true, params: [col('c1', 'Color 1', '#ff3b30'), col('c2', 'Color 2', '#2f7cff'), col('c3', 'Color 3', '#30d158'), col('c4', 'Color 4', '#ffd60a'), n('blend', 'Blend', 100, 0, 100), sel('mode', 'Blending Mode', [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['softLight', 'Soft Light']])] },
  lens_flare: { name: 'Lens Flare', category: 'Generate', params: [pt('center', 'Flare Center', [0.3, 0.3]), n('brightness', 'Flare Brightness', 100, 0, 300), sel('type', 'Lens Type', [['50', '50-300mm Zoom'], ['35', '35mm Prime'], ['105', '105mm Prime']]), n('blend', 'Blend With Original', 0, 0, 100)] },
  grid: { name: 'Grid', category: 'Generate', params: [n('size', 'Size', 10, 1, 100), n('border', 'Border', 2, 0, 50), col('color', 'Color', '#ffffff'), n('opacity', 'Opacity', 100, 0, 100), bool('invert', 'Invert Grid', false)] },
  circle: { name: 'Circle', category: 'Generate', params: [pt('center', 'Center'), n('radius', 'Radius', 20, 0, 100), n('feather', 'Feather', 1, 0, 50), col('color', 'Color', '#ffffff'), n('opacity', 'Opacity', 100, 0, 100), bool('invert', 'Invert Circle', false)] },
  color_fill: { name: 'Fill Color', category: 'Generate', masks: true, params: [col('color', 'Color', '#2f7cff'), n('opacity', 'Opacity', 100, 0, 100)] },
  timecode_burnin: { name: 'Timecode', category: 'Video', params: [pt('position', 'Position', [0.5, 0.92]), n('size', 'Size', 6, 1, 30), n('opacity', 'Opacity', 70, 0, 100), sel('source', 'Time Display', [['sequence', 'Sequence'], ['media', 'Media']]), txt('prefix', 'Prefix', '')] },
  clip_name: { name: 'Clip Name', category: 'Video', params: [pt('position', 'Position', [0.5, 0.08]), n('size', 'Size', 5, 1, 30), n('opacity', 'Opacity', 70, 0, 100)] },

  // ---- Keying ----
  ultra_key: { name: 'Ultra Key', category: 'Keying', params: [
    sel('output', 'Output', [['composite', 'Composite'], ['alpha', 'Alpha Channel'], ['color', 'Color Channel']]), sel('setting', 'Setting', [['default', 'Default'], ['relaxed', 'Relaxed'], ['aggressive', 'Aggressive']]),
    col('keyColor', 'Key Color', '#1fc23a'),
    n('transparency', 'Transparency', 45, 0, 100), n('highlight', 'Highlight', 10, 0, 100), n('shadow', 'Shadow', 50, 0, 100), n('tolerance', 'Tolerance', 50, 0, 100), n('pedestal', 'Pedestal', 10, 0, 100),
    n('choke', 'Choke', 0, 0, 100), n('soften', 'Soften', 0, 0, 100), n('mattContrast', 'Contrast', 0, 0, 100), n('midpoint', 'Mid Point', 50, 0, 100),
    n('desaturate', 'Spill Desaturate', 25, 0, 100), n('range', 'Spill Range', 50, 0, 100), n('spill', 'Spill', 50, 0, 100), n('luma', 'Spill Luma', 50, 0, 100),
    n('ccSaturation', 'Saturation', 100, 0, 200), n('ccHue', 'Hue', 0, -180, 180), n('ccLuminance', 'Luminance', 0, -100, 100)] },
  color_key: { name: 'Color Key', category: 'Keying', params: [col('keyColor', 'Key Color', '#1fc23a'), n('tolerance', 'Color Tolerance', 30, 0, 255, 1), n('thinning', 'Edge Thin', 0, -5, 5, 1), n('feather', 'Edge Feather', 0, 0, 50)] },
  luma_key: { name: 'Luma Key', category: 'Keying', params: [n('threshold', 'Threshold', 100, 0, 100), n('cutoff', 'Cutoff', 0, 0, 100)] },
  track_matte: { name: 'Track Matte Key', category: 'Keying', params: [trk('track', 'Matte Track'), sel('composite', 'Composite Using', [['alpha', 'Matte Alpha'], ['luma', 'Matte Luma']]), bool('reverse', 'Reverse', false)] },
  alpha_adjust: { name: 'Alpha Adjust', category: 'Keying', params: [n('opacity', 'Opacity', 100, 0, 100), bool('ignore', 'Ignore Alpha', false), bool('invert', 'Invert Alpha', false), bool('maskOnly', 'Mask Only', false)] },
  spill_suppressor: { name: 'Spill Suppressor', category: 'Keying', params: [col('color', 'Color to Suppress', '#1fc23a'), n('amount', 'Suppression', 50, 0, 200)] },
  matte_choker: { name: 'Matte Choker', category: 'Keying', params: [n('choke', 'Choke', 0, -100, 100), n('softness', 'Softness', 0, 0, 100)] },

  // ---- Noise & Grain ----
  noise: { name: 'Noise', category: 'Noise & Grain', masks: true, params: [n('amount', 'Amount of Noise', 10, 0, 100), bool('color', 'Use Color Noise', true), bool('clip', 'Clip Result Values', true)] },
  film_grain: { name: 'Film Grain', category: 'Noise & Grain', masks: true, params: [n('intensity', 'Intensity', 20, 0, 100), n('size', 'Grain Size', 1.5, 0.5, 8), n('softness', 'Softness', 30, 0, 100), bool('mono', 'Monochrome', true)] },
  median: { name: 'Median (Noise Reduction)', category: 'Noise & Grain', masks: true, params: [n('radius', 'Radius', 2, 0, 10, 1)] },
  denoise: { name: 'Video Denoise', category: 'Noise & Grain', masks: true, params: [n('strength', 'Strength', 30, 0, 100), n('detail', 'Detail Preservation', 50, 0, 100)] },

  // ---- Perspective ----
  drop_shadow: { name: 'Drop Shadow', category: 'Perspective', params: [col('color', 'Shadow Color', '#000000'), n('opacity', 'Opacity', 50, 0, 100), ang('direction', 'Direction', 135), n('distance', 'Distance', 10, 0, 500), n('softness', 'Softness', 10, 0, 250), bool('only', 'Shadow Only', false)] },
  basic_3d: { name: 'Basic 3D', category: 'Perspective', params: [ang('swivel', 'Swivel', 0), ang('tilt', 'Tilt', 0), n('distance', 'Distance to Image', 0, -100, 100), bool('specular', 'Specular Highlight', false)] },
  bevel_alpha: { name: 'Bevel Alpha', category: 'Perspective', params: [n('thickness', 'Edge Thickness', 3, 0, 50), ang('angle', 'Light Angle', -60), n('intensity', 'Light Intensity', 40, 0, 100)] },

  // ---- Stylize ----
  mosaic: { name: 'Mosaic', category: 'Stylize', masks: true, params: [n('hBlocks', 'Horizontal Blocks', 40, 1, 2000, 1), n('vBlocks', 'Vertical Blocks', 24, 1, 2000, 1), bool('sharp', 'Sharp Colors', false)] },
  posterize: { name: 'Posterize', category: 'Stylize', masks: true, params: [n('levels', 'Level', 6, 2, 64, 1)] },
  find_edges: { name: 'Find Edges', category: 'Stylize', masks: true, params: [bool('invert', 'Invert', false), n('blend', 'Blend With Original', 0, 0, 100)] },
  emboss: { name: 'Emboss', category: 'Stylize', masks: true, params: [ang('direction', 'Direction', 45), n('relief', 'Relief', 2, 0.1, 10), n('contrast', 'Contrast', 100, 0, 500), n('blend', 'Blend With Original', 0, 0, 100)] },
  glow: { name: 'Glow', category: 'Stylize', masks: true, params: [n('threshold', 'Glow Threshold', 60, 0, 100), n('radius', 'Glow Radius', 20, 0, 300), n('intensity', 'Glow Intensity', 1, 0, 10, 0.01), col('tint', 'Glow Tint', '#ffffff')] },
  vignette: { name: 'Vignette', category: 'Stylize', masks: true, params: [n('amount', 'Amount', 50, -100, 100), n('midpoint', 'Midpoint', 50, 0, 100), n('roundness', 'Roundness', 0, -100, 100), n('feather', 'Feather', 50, 0, 100)] },
  replicate: { name: 'Replicate', category: 'Stylize', params: [n('count', 'Count', 2, 2, 16, 1)] },
  solarize: { name: 'Solarize', category: 'Stylize', masks: true, params: [n('threshold', 'Threshold', 50, 0, 100)] },
  halftone: { name: 'Halftone', category: 'Stylize', masks: true, params: [n('size', 'Dot Size', 8, 2, 64, 1), ang('angle', 'Angle', 45), bool('color', 'Color', false)] },
  chromatic_aberration: { name: 'Chromatic Aberration', category: 'Stylize', masks: true, params: [n('amount', 'Amount', 5, 0, 50), pt('center', 'Center')] },
  strobe: { name: 'Strobe Light', category: 'Stylize', params: [col('color', 'Strobe Color', '#ffffff'), n('period', 'Strobe Period (frames)', 6, 2, 120, 1), n('duration', 'Strobe Duration (frames)', 2, 1, 60, 1), n('blend', 'Blend', 0, 0, 100)] },
  film_damage: { name: 'Film Damage', category: 'Stylize', masks: true, params: [n('scratches', 'Scratches', 30, 0, 100), n('dust', 'Dust', 30, 0, 100), n('flicker', 'Flicker', 20, 0, 100), n('jitter', 'Gate Weave', 10, 0, 100), n('sepia', 'Sepia', 30, 0, 100)] },
  glitch: { name: 'Digital Glitch', category: 'Stylize', masks: true, params: [n('amount', 'Amount', 30, 0, 100), n('blocks', 'Block Size', 20, 2, 200, 1), n('rgbSplit', 'RGB Split', 10, 0, 100), n('speed', 'Speed', 10, 0, 60)] },

  // ---- Time ----
  posterize_time: { name: 'Posterize Time', category: 'Time', params: [n('fps', 'Frame Rate', 12, 1, 120, 0.01)] },

  // ---- Transition-style / Utility ----
  crop: { name: 'Crop', category: 'Transform', params: [n('left', 'Left', 0, 0, 100), n('top', 'Top', 0, 0, 100), n('right', 'Right', 0, 0, 100), n('bottom', 'Bottom', 0, 0, 100), bool('zoom', 'Zoom', false), n('feather', 'Edge Feather', 0, 0, 500)] },
  horizontal_flip: { name: 'Horizontal Flip', category: 'Transform', params: [] },
  vertical_flip: { name: 'Vertical Flip', category: 'Transform', params: [] },
  auto_reframe: { name: 'Auto Reframe', category: 'Transform', analysis: 'reframe', params: [sel('motion', 'Motion Preset', [['slow', 'Slower Motion'], ['default', 'Default'], ['fast', 'Faster Motion']], 'default'), n('scale', 'Reframe Scale', 100, 50, 300), { name: 'offset', label: 'Reframe Offset', type: 'point', default: [0, 0] }] },

  // ---- Immersive ----
  vr_rotate: { name: 'VR Rotate Sphere', category: 'Immersive Video', params: [ang('tilt', 'Tilt (X axis)', 0), ang('pan', 'Pan (Y axis)', 0), ang('roll', 'Roll (Z axis)', 0)] },
  vr_projection: { name: 'VR Projection (Flat View)', category: 'Immersive Video', params: [ang('pan', 'Pan', 0), ang('tilt', 'Tilt', 0), ang('roll', 'Roll', 0), n('fov', 'Field of View', 90, 20, 170)] },
  vr_blur: { name: 'VR Blur', category: 'Immersive Video', masks: true, params: [n('blurriness', 'Blurriness', 10, 0, 200)] },
  little_planet: { name: 'VR Little Planet', category: 'Immersive Video', params: [n('zoom', 'Zoom', 1, 0.2, 5, 0.01), ang('rotate', 'Rotation', 0)] },
};

export const AUDIO_EFFECTS = {
  volume: { name: 'Volume', category: 'Intrinsic', intrinsic: true, params: [bool('bypass', 'Bypass', false), n('level', 'Level', 0, -96, 15, 0.1, { unit: 'dB' })] },
  channel_volume: { name: 'Channel Volume', category: 'Intrinsic', intrinsic: true, params: [n('left', 'Left', 0, -96, 15, 0.1, { unit: 'dB' }), n('right', 'Right', 0, -96, 15, 0.1, { unit: 'dB' })] },
  panner: { name: 'Panner', category: 'Intrinsic', intrinsic: true, params: [n('balance', 'Balance', 0, -100, 100, 1)] },
  parametric_eq: { name: 'Parametric Equalizer', category: 'Filter and EQ', params: [
    n('hpFreq', 'Low Cut', 20, 10, 2000, 1, { unit: 'Hz' }), bool('hpOn', 'Low Cut On', false),
    n('lsFreq', 'Low Shelf Freq', 120, 20, 2000, 1), n('lsGain', 'Low Shelf Gain', 0, -24, 24),
    n('p1Freq', 'Band 1 Freq', 400, 20, 20000, 1), n('p1Gain', 'Band 1 Gain', 0, -24, 24), n('p1Q', 'Band 1 Q', 1, 0.1, 30, 0.01),
    n('p2Freq', 'Band 2 Freq', 1500, 20, 20000, 1), n('p2Gain', 'Band 2 Gain', 0, -24, 24), n('p2Q', 'Band 2 Q', 1, 0.1, 30, 0.01),
    n('p3Freq', 'Band 3 Freq', 5000, 20, 20000, 1), n('p3Gain', 'Band 3 Gain', 0, -24, 24), n('p3Q', 'Band 3 Q', 1, 0.1, 30, 0.01),
    n('hsFreq', 'High Shelf Freq', 8000, 1000, 20000, 1), n('hsGain', 'High Shelf Gain', 0, -24, 24),
    n('lpFreq', 'High Cut', 20000, 1000, 22000, 1), bool('lpOn', 'High Cut On', false), n('output', 'Output Gain', 0, -24, 24)] },
  graphic_eq: { name: 'Graphic Equalizer (10 Bands)', category: 'Filter and EQ', params: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f) => n('g' + f, (f >= 1000 ? f / 1000 + 'k' : f) + ' Hz', 0, -18, 18, 0.1))
    .concat([n('output', 'Output Gain', 0, -24, 24)]) },
  highpass: { name: 'Highpass', category: 'Filter and EQ', params: [n('freq', 'Cutoff', 80, 10, 20000, 1, { unit: 'Hz' })] },
  lowpass: { name: 'Lowpass', category: 'Filter and EQ', params: [n('freq', 'Cutoff', 8000, 10, 22000, 1, { unit: 'Hz' })] },
  bandpass: { name: 'Bandpass', category: 'Filter and EQ', params: [n('freq', 'Center', 1000, 20, 20000, 1), n('q', 'Q', 1, 0.1, 30, 0.01)] },
  notch: { name: 'Notch Filter', category: 'Filter and EQ', params: [n('freq', 'Frequency', 60, 20, 20000, 1), n('q', 'Q', 10, 0.1, 100, 0.1)] },
  dehum: { name: 'DeHummer', category: 'Noise Reduction / Restoration', params: [sel('freq', 'Frequency', [['50', '50 Hz'], ['60', '60 Hz']], '60'), n('harmonics', 'Harmonics', 4, 1, 8, 1), n('q', 'Q', 20, 1, 100, 1)] },
  bass: { name: 'Bass', category: 'Filter and EQ', params: [n('boost', 'Boost', 0, -24, 24)] },
  treble: { name: 'Treble', category: 'Filter and EQ', params: [n('boost', 'Boost', 0, -24, 24)] },
  compressor: { name: 'Dynamics Compressor', category: 'Amplitude and Compression', params: [n('threshold', 'Threshold', -18, -60, 0, 0.1, { unit: 'dB' }), n('ratio', 'Ratio', 4, 1, 20, 0.1), n('attack', 'Attack', 10, 0, 1000, 1, { unit: 'ms' }), n('release', 'Release', 120, 0, 1000, 1, { unit: 'ms' }), n('knee', 'Knee', 6, 0, 40), n('makeup', 'Make-up Gain', 0, -12, 24)] },
  limiter: { name: 'Hard Limiter', category: 'Amplitude and Compression', params: [n('ceiling', 'Maximum Amplitude', -0.3, -24, 0, 0.1, { unit: 'dB' }), n('inputBoost', 'Input Boost', 0, 0, 24), n('release', 'Release', 80, 1, 1000, 1, { unit: 'ms' })] },
  gate: { name: 'Noise Gate', category: 'Amplitude and Compression', params: [n('threshold', 'Threshold', -45, -96, 0, 0.1, { unit: 'dB' }), n('attack', 'Attack', 2, 0, 200, 0.1, { unit: 'ms' }), n('hold', 'Hold', 50, 0, 1000, 1, { unit: 'ms' }), n('release', 'Release', 150, 1, 2000, 1, { unit: 'ms' }), n('floor', 'Floor', -80, -96, 0)] },
  deesser: { name: 'DeEsser', category: 'Amplitude and Compression', params: [n('freq', 'Center Frequency', 6500, 2000, 12000, 10, { unit: 'Hz' }), n('threshold', 'Threshold', -30, -60, 0), n('amount', 'Reduction', 6, 0, 24)] },
  audio_denoise: { name: 'DeNoise', category: 'Noise Reduction / Restoration', params: [n('amount', 'Amount', 40, 0, 100), n('floor', 'Noise Floor', -50, -90, -10)] },
  declick: { name: 'DeClicker', category: 'Noise Reduction / Restoration', params: [n('sensitivity', 'Sensitivity', 50, 0, 100)] },
  distortion: { name: 'Distortion', category: 'Special', params: [n('amount', 'Drive', 20, 0, 100), n('mix', 'Mix', 100, 0, 100), n('tone', 'Tone', 6000, 200, 20000, 10)] },
  reverb: { name: 'Studio Reverb', category: 'Reverb', params: [sel('room', 'Room', [['small', 'Small Room'], ['room', 'Room'], ['hall', 'Large Hall'], ['plate', 'Plate'], ['cathedral', 'Cathedral']], 'room'), n('decay', 'Decay', 1.6, 0.1, 12, 0.01, { unit: 's' }), n('predelay', 'Pre-delay', 20, 0, 300, 1, { unit: 'ms' }), n('damping', 'High Frequency Damping', 6000, 500, 20000, 10), n('mix', 'Wet', 25, 0, 100), n('dry', 'Dry', 100, 0, 100)] },
  delay: { name: 'Delay', category: 'Delay and Echo', params: [n('time', 'Delay Time', 250, 1, 2000, 1, { unit: 'ms' }), n('feedback', 'Feedback', 30, 0, 95), n('mix', 'Mix', 30, 0, 100)] },
  echo: { name: 'Multitap Echo', category: 'Delay and Echo', params: [n('left', 'Left Delay', 300, 1, 2000, 1), n('right', 'Right Delay', 450, 1, 2000, 1), n('feedback', 'Feedback', 40, 0, 95), n('mix', 'Echo Level', 35, 0, 100), n('tone', 'Tone', 4000, 200, 20000, 10)] },
  chorus: { name: 'Chorus / Flanger', category: 'Modulation', params: [sel('mode', 'Mode', [['chorus', 'Chorus'], ['flanger', 'Flanger']]), n('rate', 'Speed', 0.8, 0.05, 10, 0.01, { unit: 'Hz' }), n('depth', 'Depth', 40, 0, 100), n('feedback', 'Feedback', 20, 0, 95), n('mix', 'Mix', 50, 0, 100)] },
  pitch_shift: { name: 'Pitch Shifter', category: 'Time and Pitch', params: [n('semitones', 'Semi-tones', 0, -12, 12, 1), n('cents', 'Cents', 0, -100, 100, 1)] },
  stereo_expander: { name: 'Stereo Expander', category: 'Stereo Imagery', params: [n('width', 'Stereo Expansion', 100, 0, 300), n('center', 'Center Channel Pan', 0, -100, 100)] },
  channel_tools: { name: 'Channel Tools', category: 'Stereo Imagery', params: [sel('mode', 'Operation', [['none', 'None'], ['swap', 'Swap Channels'], ['fillLeft', 'Fill Left with Right'], ['fillRight', 'Fill Right with Left'], ['mono', 'Mono Sum'], ['invertL', 'Invert Left'], ['invertR', 'Invert Right']])] },
  dialogue_clarity: { name: 'Dialogue Clarity', category: 'Special', params: [n('rumble', 'Reduce Rumble', 50, 0, 100), n('presence', 'Presence', 30, 0, 100), n('leveling', 'Leveling', 40, 0, 100), n('air', 'Air', 20, 0, 100)] },
  loudness_radar: { name: 'Loudness Meter', category: 'Special', params: [n('target', 'Target Loudness', -23, -40, -5, 0.1, { unit: 'LUFS' })] },
};

export const TRANSITIONS = {
  cross_dissolve: { name: 'Cross Dissolve', category: 'Dissolve', params: [] },
  additive_dissolve: { name: 'Additive Dissolve', category: 'Dissolve', params: [] },
  film_dissolve: { name: 'Film Dissolve', category: 'Dissolve', params: [] },
  morph_blur: { name: 'Blur Dissolve', category: 'Dissolve', params: [n('blur', 'Blur Amount', 30, 0, 200)] },
  dip_black: { name: 'Dip to Black', category: 'Dissolve', params: [] },
  dip_white: { name: 'Dip to White', category: 'Dissolve', params: [] },
  dip_color: { name: 'Dip to Color', category: 'Dissolve', params: [col('color', 'Color', '#2f7cff')] },
  wipe: { name: 'Wipe', category: 'Wipe', params: [ang('angle', 'Angle', 0), n('feather', 'Border Feather', 2, 0, 50), n('border', 'Border Width', 0, 0, 50), col('borderColor', 'Border Color', '#ffffff')] },
  barn_doors: { name: 'Barn Doors', category: 'Wipe', params: [bool('vertical', 'Vertical', false), n('feather', 'Feather', 1, 0, 50)] },
  clock_wipe: { name: 'Clock Wipe', category: 'Wipe', params: [n('feather', 'Feather', 1, 0, 50)] },
  radial_wipe: { name: 'Radial Wipe', category: 'Wipe', params: [n('feather', 'Feather', 1, 0, 50)] },
  venetian_blinds: { name: 'Venetian Blinds', category: 'Wipe', params: [n('count', 'Blinds', 10, 2, 60, 1), bool('vertical', 'Vertical', false)] },
  checker_wipe: { name: 'Checker Wipe', category: 'Wipe', params: [n('count', 'Squares', 8, 2, 40, 1)] },
  iris_round: { name: 'Iris Round', category: 'Iris', params: [pt('center', 'Center'), n('feather', 'Feather', 2, 0, 50)] },
  iris_box: { name: 'Iris Box', category: 'Iris', params: [pt('center', 'Center'), n('feather', 'Feather', 1, 0, 50)] },
  iris_diamond: { name: 'Iris Diamond', category: 'Iris', params: [pt('center', 'Center'), n('feather', 'Feather', 1, 0, 50)] },
  iris_cross: { name: 'Iris Cross', category: 'Iris', params: [pt('center', 'Center'), n('feather', 'Feather', 1, 0, 50)] },
  slide: { name: 'Slide', category: 'Slide', params: [sel('direction', 'Direction', [['left', 'From Right'], ['right', 'From Left'], ['up', 'From Bottom'], ['down', 'From Top']])] },
  push: { name: 'Push', category: 'Slide', params: [sel('direction', 'Direction', [['left', 'Left'], ['right', 'Right'], ['up', 'Up'], ['down', 'Down']])] },
  split: { name: 'Split', category: 'Slide', params: [bool('vertical', 'Vertical', false)] },
  whip_pan: { name: 'Whip Pan', category: 'Slide', params: [sel('direction', 'Direction', [['left', 'Left'], ['right', 'Right'], ['up', 'Up'], ['down', 'Down']]), n('blur', 'Motion Blur', 60, 0, 200)] },
  cross_zoom: { name: 'Cross Zoom', category: 'Zoom', params: [n('strength', 'Zoom Strength', 40, 0, 100)] },
  zoom_in: { name: 'Zoom In', category: 'Zoom', params: [pt('center', 'Center')] },
  spin: { name: 'Spin', category: 'Zoom', params: [n('turns', 'Turns', 1, 0.25, 4, 0.25)] },
  light_leak: { name: 'Light Leak', category: 'Film', params: [col('color', 'Leak Color', '#ff9a3c'), n('intensity', 'Intensity', 80, 0, 200)] },
  film_burn: { name: 'Film Burn', category: 'Film', params: [n('intensity', 'Intensity', 100, 0, 200)] },
  flash: { name: 'Flash', category: 'Film', params: [col('color', 'Color', '#ffffff')] },
  glitch: { name: 'Glitch', category: 'Stylized', params: [n('amount', 'Amount', 60, 0, 100)] },
  pixelate: { name: 'Pixelate', category: 'Stylized', params: [n('size', 'Max Block Size', 60, 2, 200, 1)] },
  page_turn: { name: 'Page Turn', category: 'Stylized', params: [] },
  shape_circle: { name: 'Shape Reveal: Circles', category: 'Shape', params: [n('count', 'Count', 6, 1, 30, 1)] },
  shape_hex: { name: 'Shape Reveal: Hexagons', category: 'Shape', params: [n('count', 'Count', 10, 2, 40, 1)] },
};

export const AUDIO_TRANSITIONS = {
  constant_power: { name: 'Constant Power', category: 'Crossfade', params: [] },
  constant_gain: { name: 'Constant Gain', category: 'Crossfade', params: [] },
  exponential: { name: 'Exponential Fade', category: 'Crossfade', params: [] },
};

// Plugin effects are merged in at runtime.
export const PLUGIN_EFFECTS = {};
export const PLUGIN_TRANSITIONS = {};

export function defFor(type) {
  return VIDEO_EFFECTS[type] || AUDIO_EFFECTS[type] || PLUGIN_EFFECTS[type] || null;
}
export function isAudioEffect(type) { return !!AUDIO_EFFECTS[type]; }
export function transitionDef(type) { return TRANSITIONS[type] || AUDIO_TRANSITIONS[type] || PLUGIN_TRANSITIONS[type] || null; }

export function makeEffect(type, overrides = {}) {
  const def = defFor(type);
  if (!def) throw new Error('Unknown effect ' + type);
  const params = {};
  for (const p of def.params) params[p.name] = deepClone(p.default);
  return { id: uid('fx'), type, enabled: true, params: Object.assign(params, deepClone(overrides)), keyframes: {}, masks: [] };
}

export function makeTransition(type, dur, extra = {}) {
  const def = transitionDef(type);
  const params = {};
  if (def) for (const p of def.params) params[p.name] = deepClone(p.default);
  return { id: uid('tr'), type, dur, align: 'center', params, reverse: false, ...extra };
}

export function makeMask(shape = 'ellipse') {
  const base = { id: uid('mask'), shape, feather: 10, opacity: 100, expansion: 0, invert: false, mode: 'add', keyframes: {}, tracking: { method: 'position' } };
  if (shape === 'ellipse' || shape === 'rect') base.points = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];
  else base.points = [[0.4, 0.3], [0.6, 0.35], [0.62, 0.65], [0.38, 0.7]];
  base.closed = true;
  return base;
}

export function effectCategories() {
  const cats = {};
  for (const [k, d] of Object.entries({ ...VIDEO_EFFECTS, ...PLUGIN_EFFECTS })) if (!d.intrinsic) (cats[d.category] = cats[d.category] || []).push(k);
  return cats;
}

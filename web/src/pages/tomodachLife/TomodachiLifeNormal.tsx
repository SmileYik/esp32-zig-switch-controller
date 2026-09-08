import React, { useState, useRef, useMemo } from 'react';
import './TomodachiLifeNormal.css';
import { type PixelData, type RGBColor } from './color';
import { MacroAlgorithmMap, type MacroAlgorithm, type MacroAlgorithmType } from './algorithms/macroAlgorithm';
import { generateZigByteArray, loadImageFromZigByteArray } from './image';
import ColorPickerModal from './ColorPickerModal';
import ImageEditorModal from './ImageEditorModal';
import { type QuantizeAlgorithm, QuantizeAlgorithmMap, type QuantizeType } from './quantizeAlgorithm';
import { compressMacro } from '../../compressMacro';

interface TomodachiLifeNormalProps {
  onChangeScript: (value: string) => void;
}

function TomodachiLifeNormal({
  onChangeScript
}: TomodachiLifeNormalProps) {
  const [cropWidth, setCropWidth] = useState<number>(256);
  const [cropHeight, setCropHeight] = useState<number>(256);
  const [downDelayMs, setDownDelayMs] = useState<number>(100);
  const [upDelayMs, setUpDelayMs] = useState<number>(100);
  const [uiDelayMs, setUiDelayMs] = useState<number>(100);

  const [originalImage, setOriginalImage] = useState<HTMLImageElement | null>(null);
  const [croppedImage, setCroppedImage] = useState<HTMLImageElement | null>(null);
  const [pixelIndices, setPixelIndices] = useState<(number | null)[][]>([]);

  const [originalPalette, setOriginalPalette] = useState<RGBColor[]>([]);
  const [currentPalette, setCurrentPalette] = useState<RGBColor[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const [byteArray, setByteArray] = useState<Uint8Array | null>(null);

  const [colorCount, setColorCount] = useState<number>(4);

  const [isCropping, setIsCropping] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const [scale, setScale] = useState<number>(1);
  const [minScale, setMinScale] = useState<number>(0.1);
  const [maxScale, setMaxScale] = useState<number>(100);
  const [imgOffset, setImgOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showEditorModal, setShowEditorModal] = useState<boolean>(false);

  const [compressScript, setCompressScript] = useState<boolean>(false);

  const [macroAlgorithm, setMacroAlgorithm] = useState<MacroAlgorithm>(MacroAlgorithmMap.segment);
  const onSetMarcoAlgorithm = (value: string) => {
    let alg = MacroAlgorithmMap.segment;
    Object.entries(MacroAlgorithmMap).forEach(([k, v]) => {
      if (k === value) alg = v;
    });
    setMacroAlgorithm(alg);
  };

  const [quantizeAlgorithm, setQuantizeAlgorithm] = useState<QuantizeAlgorithm>(QuantizeAlgorithmMap.normal);
  const onSetQuantizeAlgorithm = (value: string) => {
    let alg = QuantizeAlgorithmMap.normal;
    Object.entries(QuantizeAlgorithmMap).forEach(([k, v]) => {
      if (k === value) alg = v;
    });
    setQuantizeAlgorithm(alg);
  };

  const updateRenderOutput = (pIndices: (number | null)[][], palette: RGBColor[]) => {
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.createImageData(cropWidth, cropHeight);
    const data = imageData.data;

    for (let y = 0; y < cropHeight; y++) {
      for (let x = 0; x < cropWidth; x++) {
        const idx = (y * cropWidth + x) * 4;
        const colorIdx = pIndices[y]?.[x];
        if (colorIdx !== undefined && colorIdx !== null && palette[colorIdx]) {
          const color = palette[colorIdx];
          data[idx] = color.r;
          data[idx + 1] = color.g;
          data[idx + 2] = color.b;
          data[idx + 3] = 255;
        } else {
          data[idx + 3] = 0;
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);

    const croppedImg = new Image();
    croppedImg.onload = () => setCroppedImage(croppedImg);
    croppedImg.src = canvas.toDataURL('image/png');

    const bin = generateZigByteArray({width: cropWidth, height: cropHeight, palette, pIndices});
    setByteArray(bin);
  };

  // 解析并装载二进制文件 (.bin)
  const handleBinLoad = (buffer: Uint8Array) => {
    const image = loadImageFromZigByteArray(buffer);
    if (image == null) return;

    const w = image.width;
    const h = image.height;
    const palette: RGBColor[] = image.palette;
    const pIndices: (number | null)[][] = image.pIndices;

    setCropWidth(w);
    setCropHeight(h);
    setPixelIndices(pIndices);
    setOriginalPalette(palette);
    setCurrentPalette(palette);
    setColorCount(palette.length || 4);

    // 生成像素预览图像
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const imgData = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const pixelIdx = (y * w + x) * 4;
          const colorIdx = pIndices[y][x];
          if (colorIdx !== null && palette[colorIdx]) {
            const c = palette[colorIdx];
            imgData.data[pixelIdx] = c.r;
            imgData.data[pixelIdx + 1] = c.g;
            imgData.data[pixelIdx + 2] = c.b;
            imgData.data[pixelIdx + 3] = 255;
          } else {
            imgData.data[pixelIdx + 3] = 0;
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);

      const binImg = new Image();
      binImg.onload = () => {
        setOriginalImage(binImg);
        setCroppedImage(binImg);
        setIsCropping(false);
      };
      binImg.src = canvas.toDataURL('image/png');
    }

    setByteArray(buffer);
  };

  const handleBinUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const buffer = new Uint8Array(evt.target?.result as ArrayBuffer);
      handleBinLoad(buffer);
    };
    reader.readAsArrayBuffer(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.name.endsWith('.bin')) {
      handleBinUpload(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        setOriginalImage(img);
        setCroppedImage(null);
        setIsCropping(true);

        const fitScale = Math.min(cropWidth / img.naturalWidth, cropHeight / img.naturalHeight);
        setScale(fitScale);
        setMinScale(fitScale * 0.2);
        setMaxScale(fitScale * 10);
        setImgOffset({
          x: (cropWidth - img.naturalWidth * fitScale) / 2,
          y: (cropHeight - img.naturalHeight * fitScale) / 2,
        });
      };
      img.src = evt.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleApplyCropAndGenerate = () => {
    if (!originalImage) return;
    setIsProcessing(true);

    setTimeout(() => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = cropWidth;
      canvas.height = cropHeight;
      ctx.clearRect(0, 0, cropWidth, cropHeight);

      ctx.drawImage(
        originalImage,
        imgOffset.x,
        imgOffset.y,
        originalImage.naturalWidth * scale,
        originalImage.naturalHeight * scale
      );

      const imageData = ctx.getImageData(0, 0, cropWidth, cropHeight);
      const data = imageData.data;

      const rawPixels: PixelData[][] = [];
      for (let y = 0; y < cropHeight; y++) {
        const row: PixelData[] = [];
        for (let x = 0; x < cropWidth; x++) {
          const idx = (y * cropWidth + x) * 4;
          const a = data[idx + 3];
          row.push(a === 0 ? null : { r: data[idx], g: data[idx + 1], b: data[idx + 2] });
        }
        rawPixels.push(row);
      }

      const { palette, pixelIndices: pIndices } = quantizeAlgorithm.quantize(rawPixels, colorCount, cropWidth, cropHeight);

      setPixelIndices(pIndices);
      setOriginalPalette(palette);
      setCurrentPalette(palette);

      updateRenderOutput(pIndices, palette);

      setIsCropping(false);
      setIsProcessing(false);
    }, 50);
  };

  const handleResetAllColors = () => {
    setCurrentPalette([...originalPalette]);
    updateRenderOutput(pixelIndices, originalPalette);
  };

  const updateScaleWithCenter = (newScale: number) => {
    const clampedScale = Math.min(Math.max(minScale, newScale), maxScale);
    const ratio = clampedScale / scale;
    const centerX = cropWidth / 2;
    const centerY = cropHeight / 2;
    setScale(clampedScale);
    setImgOffset({
      x: centerX - (centerX - imgOffset.x) * ratio,
      y: centerY - (centerY - imgOffset.y) * ratio,
    });
  };

  const resetState = () => {
    setOriginalImage(null);
    setCroppedImage(null);
    setPixelIndices([]);
    setOriginalPalette([]);
    setCurrentPalette([]);
    setEditingIndex(null);
    setByteArray(null);
    setIsCropping(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const downloadScript = () => {
    const element = document.createElement('a');
    const file = new Blob([finalScript], { type: 'text/plain' });
    element.href = URL.createObjectURL(file);
    element.download = 'tomodachi_macro.txt';
    document.body.appendChild(element);
    element.click();
    element.remove();
  };

  const downloadBinary = () => {
    if (!byteArray) return;
    const element = document.createElement('a');
    const file = new Blob([byteArray.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    element.href = URL.createObjectURL(file);
    element.download = 'tomodachi_image.bin';
    document.body.appendChild(element);
    element.click();
    element.remove();
  };

  const hexPreview = useMemo(() => {
    if (!byteArray) return '';
    const slice = byteArray.slice(0, 128);
    const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return byteArray.length > 128 ? `${hex} ... (共 ${byteArray.length} 字节)` : hex;
  }, [byteArray]);

  const finalScript = useMemo(() => {
    // cropWidth, cropHeight, currentPalette, pixelIndices, delayMs
    const script = macroAlgorithm.generator({
      w: cropWidth,
      h: cropHeight,
      palette: currentPalette,
      pIndices: pixelIndices,
      downDelay: downDelayMs,
      upDelay: upDelayMs,
      uiDelay: uiDelayMs,
    });
    if (compressScript) {
      return "# 已压缩\n" + compressMacro(script.split("\n")).join("\n");
    }
    return script;
  }, [cropWidth, cropHeight, downDelayMs, upDelayMs, uiDelayMs, currentPalette, pixelIndices, macroAlgorithm, compressScript]);

  const VIEWPORT_WIDTH = Math.max(360, cropWidth + 80);
  const VIEWPORT_HEIGHT = Math.max(360, cropHeight + 80);
  const PADDING_X = (VIEWPORT_WIDTH - cropWidth) / 2;
  const PADDING_Y = (VIEWPORT_HEIGHT - cropHeight) / 2;

  return (
    <div className="" onMouseUp={() => setIsDragging(false)}>
      <header className="m3-header">
        {!originalImage && (
          <input
            type="file"
            accept="image/*,.bin"
            onChange={handleFileUpload}
            ref={fileInputRef}
            className="m3-input"
          />
        )}
      </header>

      {originalImage && (
        <main>
          <div style={{ textAlign: 'center', marginBottom: '16px' }}>
            <button className="m3-btn m3-btn-outlined" onClick={resetState}>
              重新选择文件
            </button>
          </div>

          {isCropping ? (
            <div className="m3-card">
              <div className="m3-controls-bar">
                <label className="m3-input-field">
                  量化:
                  <select
                    value={quantizeAlgorithm.type}
                    onChange={(e) => onSetQuantizeAlgorithm(e.target.value)}
                    className="m3-input"
                    style={{ width: '100px' }}
                  >
                    {(Object.keys(QuantizeAlgorithmMap) as QuantizeType[]).map(e => (
                      <option value={e}>{e}</option>
                    ))}
                  </select>
                </label>

                <label className="m3-input-field">
                  色彩数:
                  <input
                    type="number"
                    min="2"
                    max="256"
                    value={colorCount}
                    onChange={(e) => setColorCount(Math.min(256, Math.max(2, parseInt(e.target.value) || 2)))}
                    className="m3-input"
                    style={{ width: '100px' }}
                  />
                </label>
              </div>
              <div className="m3-controls-bar">
                <label className="m3-input-field">
                  宽度:
                  <input
                    type="number"
                    min="16"
                    max="512"
                    value={cropWidth}
                    onChange={(e) => {
                      const newWidth = Math.max(16, parseInt(e.target.value) || 256);
                      setCropWidth(newWidth);
                      if (originalImage) {
                        const fitScale = Math.min(newWidth / originalImage.naturalWidth, cropHeight / originalImage.naturalHeight);
                        setScale(fitScale);
                        setMinScale(fitScale * 0.2);
                        setMaxScale(fitScale * 10);
                        setImgOffset({
                          x: (newWidth - originalImage.naturalWidth * fitScale) / 2,
                          y: (cropHeight - originalImage.naturalHeight * fitScale) / 2,
                        });
                      }
                    }}
                    className="m3-input"
                    style={{ width: '100px' }}
                  />
                </label>

                <label className="m3-input-field">
                  高度:
                  <input
                    type="number"
                    min="16"
                    max="512"
                    value={cropHeight}
                    onChange={(e) => {
                      const newHeight = Math.max(16, parseInt(e.target.value) || 256);
                      setCropHeight(newHeight);
                      if (originalImage) {
                        const fitScale = Math.min(cropWidth / originalImage.naturalWidth, newHeight / originalImage.naturalHeight);
                        setScale(fitScale);
                        setMinScale(fitScale * 0.2);
                        setMaxScale(fitScale * 10);
                        setImgOffset({
                          x: (cropWidth - originalImage.naturalWidth * fitScale) / 2,
                          y: (newHeight - originalImage.naturalHeight * fitScale) / 2,
                        });
                      }
                    }}
                    className="m3-input"
                    style={{ width: '100px' }}
                  />
                </label>
              </div>
              <div className="m3-controls-bar">
                <span className="m3-input-field">
                  缩放:
                  <div className="m3-input-field" style={{display: "flex", flexDirection: "column"}}>
                    <input
                      className='m3-input'
                      style={{width: "80%"}}
                      type="number"
                      value={scale}
                      onChange={(e) => updateScaleWithCenter(parseFloat(e.target.value))}
                    />
                    <input
                      className='m3-input'
                      type="range"
                      min={minScale}
                      max={maxScale}
                      step={(maxScale - minScale) / 100}
                      value={scale}
                      onChange={(e) => updateScaleWithCenter(parseFloat(e.target.value))}
                    />
                  </div>
                </span>
                
              </div>
              <div className="m3-controls-bar">
                <button
                  className="m3-btn m3-btn-filled"
                  onClick={handleApplyCropAndGenerate}
                  disabled={isProcessing}
                >
                  {isProcessing ? '生成中...' : '确认裁剪并生成数据与脚本'}
                </button>
              </div>
              <div
                className="m3-viewport-container"
                style={{
                  width: `${VIEWPORT_WIDTH}px`,
                  height: `${VIEWPORT_HEIGHT}px`,
                  cursor: isDragging ? 'grabbing' : 'grab',
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                  setDragStart({ x: e.clientX - imgOffset.x, y: e.clientY - imgOffset.y });
                }}
                onMouseMove={(e) => {
                  if (isDragging) setImgOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
                }}
                onWheel={(e) => {
                  e.preventDefault();
                  updateScaleWithCenter(scale * (e.deltaY < 0 ? 1.1 : 0.9));
                }}
              >
                <img
                  src={originalImage.src}
                  alt="原图"
                  draggable={false}
                  style={{
                    position: 'absolute',
                    left: `${PADDING_X + imgOffset.x}px`,
                    top: `${PADDING_Y + imgOffset.y}px`,
                    width: `${originalImage.naturalWidth * scale}px`,
                    height: `${originalImage.naturalHeight * scale}px`,
                    pointerEvents: 'none',
                  }}
                />

                <div
                  className="m3-crop-box"
                  style={{
                    left: `${PADDING_X}px`,
                    top: `${PADDING_Y}px`,
                    width: `${cropWidth}px`,
                    height: `${cropHeight}px`,
                    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.65)',
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="m3-result-grid">
              {/* 左侧预览与调色板区 */}
              <div className="m3-card">
                <h3 className="m3-card-title" style={{ textAlign: 'center' }}>
                  图像预览 ({cropWidth}x{cropHeight})
                </h3>

                <div style={{ textAlign: 'center' }}>
                  {croppedImage && (
                    <img
                      src={croppedImage.src}
                      alt="量化图"
                      className="m3-preview-img"
                      style={{ width: `${cropWidth}px`, height: `${cropHeight}px`, maxWidth: '100%', objectFit: 'contain' }}
                    />
                  )}
                </div>

                <div className="m3-palette-bar">
                  <span style={{ fontSize: '14px', fontWeight: 600 }}>调色板:</span>
                  <button className="m3-btn m3-btn-danger" style={{ padding: '4px 12px' }} onClick={handleResetAllColors}>
                    全部重置
                  </button>
                </div>

                <div className="m3-palette-grid">
                  {currentPalette.map((c, idx) => {
                    const orig = originalPalette[idx];
                    const isModified = orig && (orig.r !== c.r || orig.g !== c.g || orig.b !== c.b);
                    return (
                      <div
                        key={idx}
                        className="m3-palette-chip"
                        onClick={() => setEditingIndex(idx)}
                        title={`Color ${idx + 1}: RGB(${c.r},${c.g},${c.b})${isModified ? ' (已修改)' : ''}`}
                        style={{
                          backgroundColor: `rgb(${c.r},${c.g},${c.b})`,
                          border: isModified ? '2px solid #eab308' : '1px solid rgba(255,255,255,0.4)',
                          color: (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) > 180 ? '#000' : '#fff',
                        }}
                      >
                        {idx + 1}
                      </div>
                    );
                  })}
                </div>

                <div style={{ marginTop: '10px' }}>
                  <button className="m3-btn m3-btn-tonal" style={{ width: '100%' }} onClick={() => setShowEditorModal(true)}>
                    编辑图像
                  </button>
                </div>

                {/* 二进制导出 Card */}
                <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--md-color-outline-variant)' }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Zig 格式字节数组</h4>
                  <p style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--md-color-on-surface-variant)', wordBreak: 'break-all', margin: '0 0 12px 0' }}>
                    {hexPreview}
                  </p>
                  <button className="m3-btn m3-btn-tonal" style={{ width: '100%' }} onClick={downloadBinary}>
                    下载二进制 (.bin)
                  </button>
                </div>
              </div>

              {/* 右侧脚本输出区 */}
              <div className="m3-card" style={{display: "flex", flexDirection: "column"}}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h3 className="m3-card-title" style={{ margin: 0 }}>宏脚本</h3>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <label className="m3-btn m3-btn-outlined">
                      <input className="checkbox" type='checkbox' checked={compressScript} onChange={e => setCompressScript(e.target.checked)}></input>
                      压缩
                    </label>
                    <button className="m3-btn m3-btn-outlined" onClick={() => navigator.clipboard.writeText(finalScript)}>
                      复制
                    </button>
                    <button className="m3-btn m3-btn-outlined" onClick={downloadScript}>
                      下载
                    </button>
                    <button className="m3-btn m3-btn-filled" onClick={() => onChangeScript(finalScript)}>
                      准备运行
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', marginBottom: '16px' }}>
                    <label className="m3-input-field">
                      算法:
                      <select
                        value={macroAlgorithm.type}
                        onChange={(e) => onSetMarcoAlgorithm(e.target.value)}
                        className="m3-input"
                        style={{ width: '100px' }}
                      >
                        {(Object.keys(MacroAlgorithmMap) as MacroAlgorithmType[]).map(e => (
                          <option value={e}>{e}</option>
                        ))}
                      </select>
                    </label>

                    <label className="m3-input-field">
                      按下延迟:
                      <input
                        type="number"
                        min="10"
                        max="1000"
                        value={downDelayMs}
                        onChange={(e) => setDownDelayMs(parseInt(e.target.value) || 100)}
                        className="m3-input"
                        style={{ width: '100px' }}
                      />
                    </label>

                    <label className="m3-input-field">
                      弹起延迟:
                      <input
                        type="number"
                        min="10"
                        max="1000"
                        value={upDelayMs}
                        onChange={(e) => setUpDelayMs(parseInt(e.target.value) || 100)}
                        className="m3-input"
                        style={{ width: '100px' }}
                      />
                    </label>

                    <label className="m3-input-field">
                      界面延迟:
                      <input
                        type="number"
                        min="10"
                        max="1000"
                        value={uiDelayMs}
                        onChange={(e) => setUiDelayMs(parseInt(e.target.value) || 100)}
                        className="m3-input"
                        style={{ width: '100px' }}
                      />
                    </label>
                </div>

                <textarea readOnly value={finalScript} className="m3-code-block" />
              </div>
            </div>
          )}
        </main>
      )}

      {/* 颜色修改 Modal 弹窗 */}
      {editingIndex !== null && (
        <ColorPickerModal 
          editingIndex={editingIndex}
          onClose={() => setEditingIndex(null)}
          currentPalette={currentPalette}
          originalPalette={originalPalette}
          onColorChange={(colors) => {
            setCurrentPalette(colors);
            updateRenderOutput(pixelIndices, colors);
          }}
        ></ColorPickerModal>
      )}

      {showEditorModal && byteArray && (
        <ImageEditorModal
          byteArray={byteArray}
          onConfirm={(updatedBuffer) => {
            handleBinLoad(updatedBuffer);
          }}
          onClose={() => setShowEditorModal(false)}
        />
      )}
    </div>
  );
}

export default TomodachiLifeNormal;
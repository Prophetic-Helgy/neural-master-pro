import React, { useRef, useEffect, useState } from 'react';

interface Props {
  analyser: AnalyserNode | null;
  mode: 'bars' | 'circle' | 'wave' | 'alchemy' | 'circles' | 'flight' | 'smoke';
  coverArt?: string | null;
  width?: number;
  height?: number;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  exportMode?: boolean;
  metadata?: { title: string };
  bgVideoUrl?: string | null;
  creditText?: string | null;
  onBgVideoReady?: (video: HTMLVideoElement | null) => void;
}

export const AudioVisualizer: React.FC<Props> = ({ analyser, mode, coverArt, width = 800, height = 200, exportMode, metadata, onCanvasReady, bgVideoUrl, creditText, onBgVideoReady }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const [dimensions, setDimensions] = useState({ w: width, h: height });

  useEffect(() => {
    if (exportMode) {
      setDimensions({ w: width, h: height });
      return;
    }
    
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setDimensions({
          w: Math.floor(entry.contentRect.width),
          h: Math.floor(entry.contentRect.height)
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [exportMode, width, height]);

  useEffect(() => {
    if (canvasRef.current && onCanvasReady) {
      onCanvasReady(canvasRef.current);
    }
  }, [onCanvasReady, dimensions]);

  useEffect(() => {
    if (coverArt) {
      const img = new Image();
      img.src = coverArt;
      img.onload = () => { imageRef.current = img; };
    } else {
      imageRef.current = null;
    }
  }, [coverArt]);

  // Background stock video (export mode only). The element lives in a ref —
  // the rAF loop reads it every frame, so it is deliberately NOT a draw dep.
  useEffect(() => {
    const prev = videoElRef.current;
    if (prev) {
      prev.pause();
      prev.removeAttribute('src');
      prev.load();
    }
    videoElRef.current = null;
    onBgVideoReady?.(null);

    if (bgVideoUrl) {
      const v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      (v as any).playsInline = true;
      v.preload = 'auto';
      v.src = bgVideoUrl;
      v.load();
      v.play().catch(() => {});
      videoElRef.current = v;
      onBgVideoReady?.(v);
    }
    return () => {
      if (videoElRef.current) videoElRef.current.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgVideoUrl]);

  useEffect(() => {
    if (!analyser || !canvasRef.current || dimensions.w === 0 || dimensions.h === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // We shouldn't store animationId only, but re-trigger
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let animationId: number;

    const flightStars: {x: number, y: number, z: number}[] = [];
    for(let i=0; i<150; i++) {
       flightStars.push({x: Math.random()*2-1, y: Math.random()*2-1, z: Math.random()});
    }

    // Used for swarm (replacing smoke)
    const swarmParticles: {x: number, y: number, vx: number, vy: number, baseHue: number, size: number}[] = [];
    for(let i=0; i<150; i++) {
       swarmParticles.push({
          x: Math.random(),
          y: Math.random(),
          vx: (Math.random() - 0.5) * 0.002,
          vy: (Math.random() - 0.5) * 0.002,
          baseHue: 190 + Math.random() * 40, // 190-230: blue to cyan
          size: Math.random() * 2 + 1
       });
    }

    const draw = () => {
      animationId = requestAnimationFrame(draw);

      // Black background
      ctx.fillStyle = '#090a0c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Pexels background video (export mode): cover-fit under the visualizer
      const bgV = videoElRef.current;
      if (exportMode && bgV && bgV.readyState >= 2 && bgV.videoWidth > 0 && bgV.videoHeight > 0) {
        const vScale = Math.max(canvas.width / bgV.videoWidth, canvas.height / bgV.videoHeight);
        const vdw = bgV.videoWidth * vScale;
        const vd = bgV.videoHeight * vScale;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bgV, (canvas.width - vdw) / 2, (canvas.height - vd) / 2, vdw, vd);
      }

      if (mode === 'bars') {
        analyser.getByteFrequencyData(dataArray);
        // Ensure it fills the full width by using exactly the right barWidth
        const visibleBins = Math.floor(bufferLength * 0.7); // Only draw lower 70% of spectrum to fill up better
        const barWidth = canvas.width / visibleBins;
        let x = 0;

        for (let i = 0; i < visibleBins; i++) {
          const barHeight = (dataArray[i] / 255) * canvas.height;
          // Use a gradient for bars
          const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - barHeight);
          gradient.addColorStop(0, '#00ffd2');
          gradient.addColorStop(1, '#0099ff');
          
          ctx.fillStyle = gradient;
          // Add a tiny gap between bars if barWidth is large enough
          const gap = barWidth > 2 ? 1 : 0;
          ctx.fillRect(x, canvas.height - barHeight, barWidth - gap, barHeight);
          x += barWidth;
        }
      } else if (mode === 'circle') {
        const timeData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(dataArray);

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const radius = Math.min(centerX, centerY) * 0.35; // keep radius for aura distance
        const imgRadius = radius * 2; // double image size
        
        let localRms = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] / 128) - 1;
          localRms += v * v;
        }
        localRms = Math.sqrt(localRms / timeData.length);
        const intensity = Math.min(localRms * 3, 1);

        // Draw center logo/cover
        ctx.save();
        // Add heartbeat scale
        const currentScale = 1.0 + (intensity * 0.15);
        ctx.translate(centerX, centerY);
        ctx.scale(currentScale, currentScale);
        ctx.translate(-centerX, -centerY);

        ctx.beginPath();
        ctx.arc(centerX, centerY, imgRadius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        if (imageRef.current) {
           const img = imageRef.current;
           const imgAspect = img.width / img.height;
           let dw = imgRadius * 2;
           let dh = imgRadius * 2;
           if (imgAspect > 1) { dw = dh * imgAspect; } 
           else { dh = dw / imgAspect; }
           // Add high quality smoothing
           ctx.imageSmoothingEnabled = true;
           ctx.imageSmoothingQuality = 'high';
           ctx.drawImage(img, centerX - dw/2, centerY - dh/2, dw, dh);
        } else {
           // Placeholder Neon Brain Vector
           ctx.fillStyle = '#0a0a0c';
           ctx.fillRect(0,0, canvas.width, canvas.height);
           ctx.font = `bold ${imgRadius * 0.4}px sans-serif`;
           ctx.textAlign = 'center';
           ctx.textBaseline = 'middle';
           ctx.fillStyle = `rgba(0, 255, 255, ${0.5 + intensity*0.5})`;
           ctx.shadowColor = '#00ffff';
           ctx.shadowBlur = 10 + intensity * 20;
           ctx.fillText('NMP', centerX, centerY);
        }
        ctx.restore();

        // Chaotic glitch aura grows from standard radius offset so it surrounds the bigger image nicely or emanates from inside it. 
        // We will push the aura start circle out by radius*1.2 so it peeks out from the big image
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < bufferLength; i += 4) {
          const val = dataArray[i] / 255;
          if (val < 0.1) continue;

          const angle = (i / bufferLength) * Math.PI * 2;
          const glitchOffset = (Math.random() - 0.5) * intensity * 50; 
          
          const length = val * radius * 1.5 + (Math.random() < 0.1 ? glitchOffset : 0);
          const startRadius = radius * 1.8 * currentScale;
          const endRadius = (radius * 1.8 + length) * currentScale;

          const x1 = centerX + Math.cos(angle + glitchOffset*0.01) * startRadius;
          const y1 = centerY + Math.sin(angle + glitchOffset*0.01) * startRadius;
          
          const x2 = centerX + Math.cos(angle) * endRadius;
          const y2 = centerY + Math.sin(angle) * endRadius;

          ctx.strokeStyle = `rgba(0, ${150 + Math.random()*105}, 255, ${0.4 + val*0.6})`;
          ctx.lineWidth = Math.random() > 0.9 ? 3 : 1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // Glitch disconnected dots
          if (Math.random() > 0.8 && val > 0.5) {
             ctx.fillStyle = ctx.strokeStyle;
             const px = x2 + Math.cos(angle) * (Math.random() * 20 + 5);
             const py = y2 + Math.sin(angle) * (Math.random() * 20 + 5);
             ctx.fillRect(px, py, 2, 2);
          }
        }
        ctx.globalCompositeOperation = 'source-over';
      } else if (mode === 'wave') {
        analyser.getByteTimeDomainData(dataArray);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00ffd2';
        ctx.beginPath();

        const sliceWidth = (canvas.width * 1.0) / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 128.0;
          const y = (v * canvas.height) / 2;

          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);

          x += sliceWidth;
        }

        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
      } else if (mode === 'alchemy') {
        analyser.getByteFrequencyData(dataArray);
        
        // Deep blue background effect
        ctx.fillStyle = 'rgba(5, 10, 20, 0.2)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const timeData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(timeData);
        let rms = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] / 128) - 1;
          rms += v * v;
        }
        rms = Math.sqrt(rms / timeData.length);

        // Draw multiple "oil spots"
        ctx.globalCompositeOperation = 'screen';
        const numSpots = 8;
        for (let i = 0; i < numSpots; i++) {
          const freqRangeStart = Math.floor(i * (dataArray.length / numSpots));
          let intensity = 0;
          for(let j=0; j<20; j++) intensity += dataArray[freqRangeStart + j] || 0;
          intensity = (intensity / 20) / 255;
          
          // Organic movement
          const slowTime = Date.now() * 0.0005;
          const x = (canvas.width / 2) + Math.sin(slowTime + i * 1.5) * (canvas.width * 0.3);
          const y = (canvas.height / 2) + Math.cos(slowTime * 0.8 + i) * (canvas.height * 0.3);
          
          const baseSize = 50 + i * 20;
          const size = baseSize + intensity * 150 + rms * 200;

          const grad = ctx.createRadialGradient(x, y, size * 0.1, x, y, size);
          // Alchemy palette: Blues, Cyans, Deep Purples
          const hue = 200 + Math.sin(slowTime + i) * 30; // 170-230 range (Cyan to Blue)
          grad.addColorStop(0, `hsla(${hue}, 100%, 60%, ${0.6 * intensity + 0.1})`);
          grad.addColorStop(0.5, `hsla(${hue + 20}, 80%, 40%, ${0.3 * intensity})`);
          grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

          ctx.fillStyle = grad;
          ctx.beginPath();
          // Slightly non-circular for "oil" feel
          const stretchX = 1 + Math.sin(slowTime * 2 + i) * 0.2;
          const stretchY = 1 + Math.cos(slowTime * 2 + i) * 0.2;
          ctx.ellipse(x, y, size * stretchX, size * stretchY, slowTime + i, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      } else if (mode === 'circles') {
        analyser.getByteFrequencyData(dataArray);
        ctx.fillStyle = 'rgba(5, 10, 15, 0.2)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const time = Date.now() * 0.001;
        ctx.globalCompositeOperation = 'screen';
        
        for (let c = 1; c <= 8; c++) {
          ctx.beginPath();
          const radiusBase = c * Math.min(cx, cy) * 0.1;
          for (let a = 0; a <= Math.PI * 2; a += 0.1) {
            const bin = Math.floor((a / (Math.PI * 2)) * bufferLength * 0.5) % bufferLength;
            const val = dataArray[bin] / 255.0;
            // Bizarre warping effect based on frequency
            const distortion = Math.sin(a * (3 + c) + time) * 20 * val + Math.cos(a * 5 - time * 2) * 10 * val;
            const r = radiusBase + distortion * (c * 0.8);
            
            const dir = c % 2 === 0 ? 1 : -1;
            const x = cx + Math.cos(a + time * 0.2 * dir) * r;
            const y = cy + Math.sin(a + time * 0.2 * dir) * r;
            
            if (a === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          // Neon blue/cyan styling
          ctx.strokeStyle = `hsla(190, 100%, ${50 + c * 5}%, ${0.2 + (dataArray[c*5]/255)*0.8})`;
          ctx.lineWidth = 2 + (dataArray[c*3]/255) * 3;
          ctx.shadowColor = '#00ffd2';
          ctx.shadowBlur = 5 + (dataArray[c*2]/255) * 15;
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.shadowBlur = 0;
      } else if (mode === 'flight') {
        analyser.getByteFrequencyData(dataArray);
        ctx.fillStyle = 'rgba(2, 6, 12, 0.3)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        
        // Calculate bass energy for speed
        let bass = 0;
        for (let i = 0; i < 10; i++) bass += dataArray[i];
        bass = (bass / 10) / 255.0;
        const speed = 0.005 + bass * 0.05;

        ctx.globalCompositeOperation = 'screen';
        flightStars.forEach(star => {
          star.z -= speed;
          if (star.z <= 0) {
            star.x = Math.random() * 2 - 1;
            star.y = Math.random() * 2 - 1;
            star.z = 1;
          }
          
          const px = cx + (star.x / star.z) * cx;
          const py = cy + (star.y / star.z) * cy;
          const pz = 1 - star.z; // Inverse z for brightness/size
          
          const prevZ = star.z + speed;
          const prevPx = cx + (star.x / prevZ) * cx;
          const prevPy = cy + (star.y / prevZ) * cy;

          // Motion trail
          ctx.beginPath();
          ctx.moveTo(prevPx, prevPy);
          ctx.lineTo(px, py);
          ctx.strokeStyle = `hsla(200, 100%, ${50 + pz * 50}%, ${pz})`;
          ctx.lineWidth = pz * 3 + bass * 2;
          ctx.stroke();
          
          // Star core
          ctx.beginPath();
          ctx.arc(px, py, pz * 2 + bass * 1.5, 0, Math.PI * 2);
          ctx.fillStyle = '#00ffd2';
          ctx.fill();
        });
        ctx.globalCompositeOperation = 'source-over';
      } else if (mode === 'smoke') {
        // Redefined "smoke" to "Neon Swarm / Fireflies"
        analyser.getByteFrequencyData(dataArray);
        ctx.fillStyle = 'rgba(2, 5, 12, 0.25)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.globalCompositeOperation = 'screen';
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        
        swarmParticles.forEach((p, i) => {
           // Mapping each particle to a frequency bin
           const bin = Math.floor(i * (bufferLength * 0.5) / swarmParticles.length);
           const val = dataArray[bin] / 255.0;
           
           // Particle behavior: vibrate based on audio
           p.x += p.vx + (Math.random() - 0.5) * val * 0.02;
           p.y += p.vy + (Math.random() - 0.5) * val * 0.02;
           
           // Wrap around
           if (p.x < 0) p.x = 1; if (p.x > 1) p.x = 0;
           if (p.y < 0) p.y = 1; if (p.y > 1) p.y = 0;
           
           // Subtle drift and noise Instead of rigid center orbit
           if (val > 0.3) {
             const cxTarget = 0.5 + Math.sin(Date.now() * 0.001 + i) * 0.3;
             const cyTarget = 0.5 + Math.cos(Date.now() * 0.001 + i) * 0.3;
             const dx = cxTarget - p.x;
             const dy = cyTarget - p.y;
             p.vx += dx * 0.001;
             p.vy += dy * 0.001;
           }
           
           // Apply dampening
           p.vx *= 0.95;
           p.vy *= 0.95;
           
           const px = p.x * canvas.width;
           const py = p.y * canvas.height;
           const size = p.size * (1 + val * 4); // Pulse
           
           // Draw trailing glow
           ctx.beginPath();
           const grad = ctx.createRadialGradient(px, py, 0, px, py, size * 3);
           grad.addColorStop(0, `hsla(${p.baseHue}, 100%, 70%, ${0.8 + val * 0.2})`);
           grad.addColorStop(0.3, `hsla(${p.baseHue}, 100%, 50%, ${0.3 + val * 0.5})`);
           grad.addColorStop(1, 'rgba(0,0,0,0)');
           
           ctx.fillStyle = grad;
           ctx.arc(px, py, size * 3, 0, Math.PI * 2);
           ctx.fill();
           
           // Draw bright core
           ctx.beginPath();
           ctx.fillStyle = '#00ffff';
           ctx.arc(px, py, size * 0.4, 0, Math.PI * 2);
           ctx.fill();
           
           // Draw connection lines if nearby and loud
           if (i > 0 && val > 0.6) {
              const prev = swarmParticles[i - 1];
              const prevPx = prev.x * canvas.width;
              const prevPy = prev.y * canvas.height;
              const dist = Math.hypot(px - prevPx, py - prevPy);
              
              if (dist < canvas.width * 0.15) {
                ctx.beginPath();
                ctx.moveTo(prevPx, prevPy);
                ctx.lineTo(px, py);
                ctx.strokeStyle = `hsla(${p.baseHue}, 100%, 60%, ${val * 0.5})`;
                ctx.lineWidth = 1;
                ctx.stroke();
              }
           }
        });
        
        ctx.globalCompositeOperation = 'source-over';
      }
      // End of main visualizer loops
      if (exportMode) {
        // Draw track metadata overlay for videos
        const titleText = metadata?.title || 'Unknown Track';
        
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        // Base sizes dynamically on canvas size
        const fontSize = Math.max(canvas.height * 0.03, 24);
        // Lift text and frame by 10%
        const paddingBottom = canvas.height * 0.15;
        
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = '#00ffd2'; // text same as frame color
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 10;
        ctx.fillText(titleText, canvas.width / 2, canvas.height - paddingBottom);
        ctx.shadowBlur = 0; // Reset

        // If not glitch mode, draw the frame and photo
        if (mode !== 'circle') {
          // Image frame (aiming for roughly ~20% of canvas area)
          const area = canvas.width * canvas.height;
          let imgSize = Math.sqrt(area * 0.20);
          // Constrain to not break the layout for odd aspect ratios
          imgSize = Math.min(imgSize, canvas.width * 0.8, canvas.height * 0.5);

          const imgX = canvas.width / 2 - imgSize / 2;
          const imgY = canvas.height - paddingBottom - fontSize - imgSize - (canvas.height * 0.02);

          // Draw neon frame
          ctx.strokeStyle = '#00ffd2'; // var(--accent)
          ctx.lineWidth = Math.max(canvas.width * 0.005, 3);
          ctx.shadowColor = '#00ffd2';
          ctx.shadowBlur = 25;
          ctx.strokeRect(imgX, imgY, imgSize, imgSize);
          ctx.shadowBlur = 0;

          // Draw the image or program logo placeholder inside the frame
          ctx.save();
          ctx.beginPath();
          ctx.rect(imgX, imgY, imgSize, imgSize);
          ctx.clip();
          if (imageRef.current) {
            const img = imageRef.current;
            const imgAspect = img.width / img.height;
            let dw = imgSize;
            let dh = imgSize;
            if (imgAspect > 1) { dw = dh * imgAspect; } 
            else { dh = dw / imgAspect; }
            ctx.drawImage(img, imgX - (dw - imgSize) / 2, imgY - (dh - imgSize) / 2, dw, dh);
          } else {
            ctx.fillStyle = '#0a0a0c';
            ctx.fillRect(imgX, imgY, imgSize, imgSize);
            ctx.fillStyle = '#00ffd2';
            ctx.font = `bold ${imgSize * 0.3}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('NMP', imgX + imgSize / 2, imgY + imgSize / 2);
          }
          ctx.restore();
        }

        // Pexels credit line (bottom-right corner)
        if (creditText) {
          const creditSize = Math.max(canvas.height * 0.01, 16);
          const creditMargin = Math.max(canvas.width * 0.015, 30);
          ctx.font = `${creditSize}px sans-serif`;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(creditText, canvas.width - creditMargin, canvas.height - creditMargin);
        }
      }

    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [analyser, mode, exportMode, metadata, dimensions]);

  return (
    <div ref={containerRef} className="w-full h-full relative rounded-lg bg-[#151619] overflow-hidden flex items-center justify-center">
      <canvas 
        ref={canvasRef} 
        className="block"
        width={dimensions.w}
        height={dimensions.h}
      />
    </div>
  );
};

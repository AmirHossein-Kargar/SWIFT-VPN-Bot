"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** A path a dot can ride: the SVG path in the scene's own coordinates, and how many dots ride it. */
export interface ParticleEdge { id: string; path: string; particles: number; tone: string }

const FRAMES = 32;

/** Whether a scene is on screen, so its motion can stop when it is not. */
export function useInView(scene: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const element = scene.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true), { threshold: 0.05 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scene]);
  return visible;
}

/** The scene tilts a little toward a fine pointer. Touch and reduced motion keep it still. */
export function useSceneTilt(scene: RefObject<HTMLElement | null>, reducedMotion: boolean) {
  useEffect(() => {
    const element = scene.current;
    if (!element || reducedMotion || !window.matchMedia("(pointer: fine)").matches) return;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = element.getBoundingClientRect();
        element.style.setProperty("--mf-tilt-x", `${(((event.clientY - box.top) / box.height - 0.5) * -3).toFixed(2)}deg`);
        element.style.setProperty("--mf-tilt-y", `${(((event.clientX - box.left) / box.width - 0.5) * 3).toFixed(2)}deg`);
      });
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      element.style.setProperty("--mf-tilt-x", "0deg");
      element.style.setProperty("--mf-tilt-y", "0deg");
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
    };
  }, [scene, reducedMotion]);
}

/**
 * Dots that follow real edge paths without touching the main thread: each path is sampled once into transform keyframes,
 * which the compositor runs by itself. They are rebuilt only when the edges or the size change. `offset-distance` would
 * look the same and run on the main thread.
 */
export function EdgeParticles({ edges, paused, width, height }: { edges: ParticleEdge[]; paused: boolean; width: number; height: number }) {
  const layer = useRef<HTMLDivElement>(null);
  const animations = useRef<Animation[]>([]);
  const signature = edges.map((edge) => `${edge.id}:${edge.particles}:${edge.tone}`).join();
  const latest = useRef(edges);
  latest.current = edges;

  useEffect(() => {
    const element = layer.current;
    if (!element) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const build = () => {
      animations.current.forEach((animation) => animation.cancel());
      animations.current = [];
      element.replaceChildren();
      const scaleX = element.offsetWidth / width;
      const scaleY = element.offsetHeight / height;
      if (!scaleX || !scaleY) return;
      for (const edge of latest.current) {
        if (!edge.particles) continue;
        path.setAttribute("d", edge.path);
        const length = path.getTotalLength();
        const keyframes = Array.from({ length: FRAMES + 1 }, (_, index) => {
          const progress = index / FRAMES;
          const point = path.getPointAtLength(length * progress);
          return { offset: progress, opacity: Math.min(1, progress / 0.08, (1 - progress) / 0.08), transform: `translate(${(point.x * scaleX).toFixed(1)}px, ${(point.y * scaleY).toFixed(1)}px)` };
        });
        const duration = 2400 + length * 5;
        for (let index = 0; index < edge.particles; index += 1) {
          const dot = document.createElement("span");
          dot.className = "mf-particle";
          dot.dataset.tone = edge.tone;
          element.append(dot);
          animations.current.push(dot.animate(keyframes, { duration, iterations: Infinity, delay: (-duration * index) / edge.particles }));
        }
      }
    };
    build();
    const resize = new ResizeObserver(build);
    resize.observe(element);
    return () => {
      resize.disconnect();
      animations.current.forEach((animation) => animation.cancel());
      animations.current = [];
    };
  }, [signature, width, height]);

  useEffect(() => {
    for (const animation of animations.current) {
      if (paused) animation.pause();
      else animation.play();
    }
  }, [paused, signature]);

  return <div ref={layer} className="mf-particles" aria-hidden />;
}

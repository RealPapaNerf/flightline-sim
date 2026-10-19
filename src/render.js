/* =====================================================================
   Minimal WebGL 1 renderer: flat-shaded, vertex-coloured meshes,
   hemisphere + sun lighting, linear fog, optional tiled texture.
   Render world is Y-up: x = east, y = up, z = south (camera looks down -Z).
   ===================================================================== */
const GLR = (function () {
  'use strict';

  /* ---------- 4x4 matrices, column-major Float32Array ---------- */
  const M4 = {
    ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
          o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      return o;
    },
    chain(...ms) { return ms.reduce((acc, m) => M4.mul(acc, m)); },
    persp(fovy, asp, n, f) {
      const m = new Float32Array(16), t = 1 / Math.tan(fovy / 2);
      m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = (2 * f * n) / (n - f);
      return m;
    },
    trans(x, y, z) { const m = M4.ident(); m[12] = x; m[13] = y; m[14] = z; return m; },
    scale(x, y, z) { const m = M4.ident(); m[0] = x; m[5] = y; m[10] = z; return m; },
    rotX(a) { const m = M4.ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
    rotY(a) { const m = M4.ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
    rotZ(a) { const m = M4.ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
    // rotation (row-major 3x3) + translation
    fromRT(R, t) {
      const m = new Float32Array(16);
      m[0] = R[0]; m[1] = R[3]; m[2] = R[6];
      m[4] = R[1]; m[5] = R[4]; m[6] = R[7];
      m[8] = R[2]; m[9] = R[5]; m[10] = R[8];
      m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
      return m;
    },
    // inverse of a rotation+translation matrix
    rigidInv(m) {
      const o = new Float32Array(16);
      o[0] = m[0]; o[1] = m[4]; o[2] = m[8];
      o[4] = m[1]; o[5] = m[5]; o[6] = m[9];
      o[8] = m[2]; o[9] = m[6]; o[10] = m[10];
      o[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
      o[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
      o[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
      o[15] = 1;
      return o;
    },
    lookAt(eye, at, up) {
      let fx = at[0] - eye[0], fy = at[1] - eye[1], fz = at[2] - eye[2];
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      let sx = fy * up[2] - fz * up[1], sy = fz * up[0] - fx * up[2], sz = fx * up[1] - fy * up[0];
      const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
      const m = new Float32Array(16);
      m[0] = sx; m[4] = sy; m[8] = sz;
      m[1] = ux; m[5] = uy; m[9] = uz;
      m[2] = -fx; m[6] = -fy; m[10] = -fz;
      m[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
      m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
      m[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
      m[15] = 1;
      return m;
    },
  };

  /* ---------- geometry builder: interleaved pos3 nrm3 col3 uv2 ---------- */
  class Geo {
    constructor(rng) { this.a = []; this.M = null; this.jit = 0; this.rng = rng || Math.random; }
    tf(p) {
      const m = this.M;
      if (!m) return p;
      return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      ];
    }
    with(m, fn) { const old = this.M; this.M = old ? M4.mul(old, m) : m; fn(); this.M = old; return this; }
    triV(p0, p1, p2, c0, c1, c2, u0, u1, u2) {
      const a = this.tf(p0), b = this.tf(p1), c = this.tf(p2);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const k = this.jit ? 1 + (this.rng() - 0.5) * this.jit : 1;
      const P = [a, b, c], C = [c0, c1, c2], UV = [u0 || [0, 0], u1 || [0, 0], u2 || [0, 0]];
      for (let i = 0; i < 3; i++)
        this.a.push(P[i][0], P[i][1], P[i][2], nx, ny, nz, C[i][0] * k, C[i][1] * k, C[i][2] * k, UV[i][0], UV[i][1]);
    }
    tri(p0, p1, p2, col, u0, u1, u2) { this.triV(p0, p1, p2, col, col, col, u0, u1, u2); }
    quad(p0, p1, p2, p3, col, uv) {
      // the two triangles share the face jitter
      const j = this.jit; let k = 1;
      if (j) { k = 1 + (this.rng() - 0.5) * j; this.jit = 0; }
      const c = [col[0] * k, col[1] * k, col[2] * k];
      uv = uv || [[0, 0], [1, 0], [1, 1], [0, 1]];
      this.tri(p0, p1, p2, c, uv[0], uv[1], uv[2]);
      this.tri(p0, p2, p3, c, uv[0], uv[2], uv[3]);
      this.jit = j;
    }
    // axis-aligned box; col = rgb or {top, bottom, side, front, back}
    box(x0, y0, z0, x1, y1, z1, col) {
      const C = Array.isArray(col) ? { top: col, bottom: col, side: col, front: col, back: col } : col;
      const s = C.side || C.top, f = C.front || s, b = C.back || s;
      this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], C.top || s); // +y
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], C.bottom || s); // -y
      this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], s); // +x
      this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], s); // -x
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], b); // +z (back / south)
      this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], f); // -z (front / north)
    }
    // box tapering along z: front rect (w0,h0) at z0, back rect (w1,h1) at z1, centred on x=0, y=yc0/yc1
    taper(z0, w0, h0, yc0, z1, w1, h1, yc1, col) {
      const F = [[-w0 / 2, yc0 - h0 / 2, z0], [w0 / 2, yc0 - h0 / 2, z0], [w0 / 2, yc0 + h0 / 2, z0], [-w0 / 2, yc0 + h0 / 2, z0]];
      const B = [[-w1 / 2, yc1 - h1 / 2, z1], [w1 / 2, yc1 - h1 / 2, z1], [w1 / 2, yc1 + h1 / 2, z1], [-w1 / 2, yc1 + h1 / 2, z1]];
      const C = Array.isArray(col) ? { top: col, bottom: col, side: col } : col;
      this.quad(F[1], F[0], F[3], F[2], C.front || C.side);
      this.quad(B[0], B[1], B[2], B[3], C.back || C.side);
      this.quad(F[3], B[3], B[2], F[2], C.top || C.side);
      this.quad(F[0], F[1], B[1], B[0], C.bottom || C.side);
      this.quad(F[1], F[2], B[2], B[1], C.side);
      this.quad(F[0], B[0], B[3], F[3], C.side);
    }
    // cylinder / cone along +y from (x,y,z); r0 bottom radius, r1 top radius
    cyl(x, y, z, r0, r1, h, n, col, caps = true, rot0 = 0) {
      for (let i = 0; i < n; i++) {
        const a0 = rot0 + (i / n) * Math.PI * 2, a1 = rot0 + ((i + 1) / n) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const b0 = [x + r0 * c0, y, z + r0 * s0], b1 = [x + r0 * c1, y, z + r0 * s1];
        const t0 = [x + r1 * c0, y + h, z + r1 * s0], t1 = [x + r1 * c1, y + h, z + r1 * s1];
        if (r1 > 0) this.quad(b0, t0, t1, b1, col);
        else this.tri(b0, t0, b1, col);
        if (caps) {
          this.tri([x, y, z], b0, b1, col);
          if (r1 > 0) this.tri([x, y + h, z], t1, t0, col);
        }
      }
    }
    // icosahedron blob centred at (x,y,z) with radii (rx, ry, rz)
    blob(x, y, z, rx, ry, rz, col) {
      const t = (1 + Math.sqrt(5)) / 2;
      const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
        .map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [x + (v[0] / l) * rx, y + (v[1] / l) * ry, z + (v[2] / l) * rz]; });
      const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
      for (const f of F) this.tri(V[f[0]], V[f[1]], V[f[2]], col);
    }
    // disc in the x–y plane facing -z
    disc(r, n, col) {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        this.tri([0, 0, 0], [r * Math.cos(a1), r * Math.sin(a1), 0], [r * Math.cos(a0), r * Math.sin(a0), 0], col);
      }
    }
  }

  const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec3 aCol; attribute vec2 aUV;
uniform mat4 uModel; uniform mat4 uVP; uniform vec3 uCam; uniform float uWorldUV;
varying vec3 vN; varying vec3 vC; varying vec2 vUV; varying float vDist;
void main(){
  vec4 wp = uModel * vec4(aPos, 1.0);
  vN = (uModel * vec4(aNrm, 0.0)).xyz;
  vC = aCol;
  vUV = mix(aUV, wp.xz, uWorldUV);
  vDist = length(wp.xyz - uCam);
  gl_Position = uVP * wp;
}`;
  const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex; uniform float uUseTex; uniform float uTexScale; uniform float uUnlit; uniform float uAlpha;
uniform float uFill; uniform float uDesat;
uniform vec3 uTint; uniform vec3 uSun; uniform vec3 uSkyAmb; uniform vec3 uGndAmb;
uniform vec3 uFog; uniform vec2 uFogRange; uniform float uFogOn; uniform float uFogK; uniform vec4 uMix; uniform vec3 uSunCol;
varying vec3 vN; varying vec3 vC; varying vec2 vUV; varying float vDist;
void main(){
  /* An orthophoto carries the ground's real colour. The vertex colour is the
     surface classifier's guess at it, and multiplying the two tints the
     photograph with the guess: Notch Peak's NAIP image is tan desert
     limestone, the classifier called 57% of the map brush and grass, and the
     product was olive pasture. Over imagery the vertex colour keeps only its
     brightness — the grain that gives close range its texture — and gives up
     its hue to the photo. */
  vec3 vc = vC;
  if (uDesat > 0.0) vc = mix(vc, vec3(dot(vc, vec3(0.299, 0.587, 0.114))), uDesat);
  vec3 c = vc * uTint;
  if (uUseTex > 0.5) c *= texture2D(uTex, vUV * uTexScale).rgb;
  c = mix(c, uMix.rgb, uMix.a); // snow cover, ice on the airframe
  if (uUnlit < 0.5) {
    vec3 n = normalize(vN);
    if (!gl_FrontFacing) n = -n;
    float d = max(dot(n, uSun), 0.0);
    vec3 amb = mix(uGndAmb, uSkyAmb, n.y * 0.5 + 0.5);
    // uFill is a fill light: it lifts the shaded side toward the sunlit one
    // and leaves a fully sunlit face exactly as it was, so nothing is ever
    // darkened by it. An orthophoto already contains the light it was flown
    // in, and shading it again multiplies two shadows together until a
    // north-facing wall is unreadable.
    c *= amb + mix(d, 1.0, uFill) * uSunCol;
  }
  // haze (linear) or weather (exponential extinction: 2% contrast left at the visibility distance)
  float f = uFogOn * max(clamp((vDist - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0), 1.0 - exp(-uFogK * vDist));
  gl_FragColor = vec4(mix(c, uFog, f), uAlpha);
}`;

  function create(canvas, antialias) {
    const opts = { antialias: !!antialias, alpha: false, stencil: true, depth: true, powerPreference: 'high-performance' };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const L = {};
    for (const n of ['aPos', 'aNrm', 'aCol', 'aUV']) L[n] = gl.getAttribLocation(prog, n);
    for (const n of ['uModel', 'uVP', 'uCam', 'uWorldUV', 'uTex', 'uUseTex', 'uTexScale', 'uUnlit', 'uAlpha', 'uTint', 'uSun', 'uSkyAmb', 'uGndAmb', 'uFog', 'uFogRange', 'uFogOn', 'uFogK', 'uMix', 'uSunCol', 'uFill', 'uDesat'])
      L[n] = gl.getUniformLocation(prog, n);
    for (const n of ['aPos', 'aNrm', 'aCol', 'aUV']) if (L[n] >= 0) gl.enableVertexAttribArray(L[n]);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    gl.uniform1i(L.uTex, 0);
    return { gl, prog, L, aniso };
  }

  function mesh(R, geo) {
    const gl = R.gl, buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.a), gl.STATIC_DRAW);
    return { buf, count: geo.a.length / 11, tris: geo.a.length / 33 };
  }

  /* An indexed mesh, for geometry that shares vertices — which means the
     terrain. A heightfield chunk has one vertex per post and two triangles per
     cell, so indexing it costs 4,485 vertices where spelling out every
     triangle costs 26,112: 5.8x the vertex data, and smooth normals become
     impossible because each triangle would carry its own copy. Takes the same
     interleaved layout as Geo (pos3 nrm3 col3 uv2, 44 bytes) so draw() and the
     shader do not change.

     Indices are Uint16, which caps a chunk at 65,536 vertices; terrain.js
     keeps a chunk to 4,485, so WebGL 1 needs no element-index extension. */
  function meshIdx(R, m) {
    const gl = R.gl, buf = gl.createBuffer(), ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, m.verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
    return { buf, ibuf, count: m.idx.length, tris: m.idx.length / 3, bytes: m.verts.byteLength + m.idx.byteLength };
  }
  function freeMesh(R, m) { if (!m) return; R.gl.deleteBuffer(m.buf); if (m.ibuf) R.gl.deleteBuffer(m.ibuf); }

  function texture(R, canvas) {
    const gl = R.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (R.aniso) gl.texParameterf(gl.TEXTURE_2D, R.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(R.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  }

  const ONE = [1, 1, 1], NOMIX = [0, 0, 0, 0];
  function draw(R, m, model, o) {
    const gl = R.gl, L = R.L;
    o = o || {};
    gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
    gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 44, 0);
    if (L.aNrm >= 0) gl.vertexAttribPointer(L.aNrm, 3, gl.FLOAT, false, 44, 12);
    gl.vertexAttribPointer(L.aCol, 3, gl.FLOAT, false, 44, 24);
    if (L.aUV >= 0) gl.vertexAttribPointer(L.aUV, 2, gl.FLOAT, false, 44, 36);
    gl.uniformMatrix4fv(L.uModel, false, model);
    gl.uniform1f(L.uUseTex, o.tex ? 1 : 0);
    if (o.tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, o.tex); }
    gl.uniform1f(L.uTexScale, o.texScale || 1);
    gl.uniform1f(L.uWorldUV, o.worldUV ? 1 : 0);
    gl.uniform1f(L.uUnlit, o.unlit ? 1 : 0);
    gl.uniform1f(L.uFill, o.fill || 0);
    gl.uniform1f(L.uDesat, o.desat || 0);
    gl.uniform1f(L.uAlpha, o.alpha == null ? 1 : o.alpha);
    gl.uniform3fv(L.uTint, o.tint || ONE);
    gl.uniform4fv(L.uMix, o.mix || NOMIX);
    gl.uniform1f(L.uFogOn, o.noFog ? 0 : 1);
    if (m.ibuf) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibuf);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    } else gl.drawArrays(gl.TRIANGLES, 0, m.count);
  }

  /* A loaded image as a texture, clamped rather than tiled: a map's orthophoto
     is draped over the terrain once, corner to corner, so repeating it would
     wrap the imagery round. WebGL 1 refuses mipmaps and REPEAT on a texture
     whose sides are not powers of two, so a non-power-of-two image gets plain
     bilinear and no mipmap — which is why the builder writes 2048 x 2048. */
  function imageTex(R, img) {
    const gl = R.gl, t = gl.createTexture();
    const pot = (v) => (v & (v - 1)) === 0;
    const two = pot(img.width) && pot(img.height);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (two) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (R.aniso) gl.texParameterf(gl.TEXTURE_2D, R.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(R.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return { tex: t, pot: two, w: img.width, h: img.height };
  }
  function freeTex(R, t) { if (t) R.gl.deleteTexture(t.tex || t); }

  return { M4, Geo, create, mesh, meshIdx, freeMesh, texture, imageTex, freeTex, draw };
})();

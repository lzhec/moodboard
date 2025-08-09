import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls';

@Component({
  selector: 'app-board',
  templateUrl: './board.component.html',
  styleUrls: ['./board.component.scss']
})
export class BoardComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvasWrap', { static: true }) canvasWrap!: ElementRef<HTMLDivElement>;
  @ViewChild('fileInput', { static: false }) fileInput!: ElementRef<HTMLInputElement>;

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private orbit!: OrbitControls;
  private transform!: TransformControls;
  private items!: THREE.Group;

  private planeMesh: THREE.Mesh | null = null;
  private planeGeoOrig: THREE.BufferGeometry | null = null;
  private cornerSpheres: THREE.Mesh[] = [];
  private draggingHandle: THREE.Mesh | null = null;
  private dragOffset = new THREE.Vector3();

  mode: 'select' | 'distort' = 'select';

  ngAfterViewInit(): void {
    this.initThree();
    this.loadSample();
    window.addEventListener('resize', this.onResize);
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.disposeAll();
  }

  private initThree() {
    const wrap = this.canvasWrap.nativeElement;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x222222);
    this.camera = new THREE.PerspectiveCamera(45, wrap.clientWidth / wrap.clientHeight, 0.1, 2000);
    this.camera.position.set(0, 100, 250);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(wrap.clientWidth, wrap.clientHeight);
    wrap.appendChild(this.renderer.domElement);

    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(0.5, 1, 0.5);
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));

    const grid = new THREE.GridHelper(1000, 40, 0x444444, 0x333333);
    grid.rotation.x = Math.PI / 2;
    grid.position.y = -1;
    this.scene.add(grid);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;

    this.items = new THREE.Group();
    this.scene.add(this.items);

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.addEventListener('dragging-changed', (e: any) => { this.orbit.enabled = !e.value; });
    this.scene.add(this.transform as unknown as THREE.Object3D);

    this.setupInteraction();
    this.animate();
  }

  private setupInteraction() {
    const dom = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handleMaterial = new THREE.MeshStandardMaterial({ color: 0xffaa00 });
    const handleGeom = new THREE.SphereGeometry(3, 12, 12);

    const getMouse = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = - ((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    dom.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.mode !== 'distort') return;
      getMouse(e as PointerEvent);
      ray.setFromCamera(mouse, this.camera);
      const intersects = ray.intersectObjects(this.cornerSpheres, false);
      if (intersects.length > 0) {
        this.draggingHandle = intersects[0].object as THREE.Mesh;
        this.dragOffset.copy(intersects[0].point).sub(this.draggingHandle.position);
        this.orbit.enabled = false;
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.draggingHandle) return;
      getMouse(e as PointerEvent);
      ray.setFromCamera(mouse, this.camera);
      const plane = new THREE.Plane();
      plane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), this.draggingHandle.position);
      const intersectPoint = new THREE.Vector3();
      ray.ray.intersectPlane(plane, intersectPoint);
      if (intersectPoint) {
        const newPos = intersectPoint.sub(this.dragOffset);
        this.draggingHandle.position.copy(newPos);
        this.updatePlaneFromHandles();
      }
    });

    window.addEventListener('pointerup', () => {
      if (this.draggingHandle) { this.draggingHandle = null; this.orbit.enabled = true; }
    });

    dom.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.mode === 'distort') return;
      if ((e as PointerEvent).button !== 0) return;
      getMouse(e as PointerEvent);
      ray.setFromCamera(mouse, this.camera);
      const intersects = this.planeMesh ? ray.intersectObject(this.planeMesh) : [];
      if ((intersects as any).length > 0) { this.transform.attach(this.planeMesh!); } else { this.transform.detach(); }
    });

    // store utilities on `this` so other methods can use
    (this as any)._ray = ray;
    (this as any)._mouse = mouse;
    (this as any)._handleGeom = handleGeom;
    (this as any)._handleMaterial = handleMaterial;
  }

  private createPlane(texture: THREE.Texture) {
    // cleanup previous
    if (this.planeMesh) {
      this.items.remove(this.planeMesh);
      this.planeMesh.geometry.dispose();
      (this.planeMesh.material as THREE.Material).dispose();
      this.cornerSpheres.forEach(s => { this.scene.remove(s); s.geometry.dispose(); });
      this.cornerSpheres.length = 0;
    }

    const geo = new THREE.PlaneGeometry(100, 100, 1, 1);
    this.planeGeoOrig = geo.clone();
    const mat = new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide });
    this.planeMesh = new THREE.Mesh(geo, mat);
    this.planeMesh.position.set(0, 50, 0);
    this.planeMesh.rotation.x = -Math.PI / 2 + 0.001;
    this.items.add(this.planeMesh);

    const verts = this.planeMesh.geometry.attributes['position'];
    for (let i = 0; i < 4; i++) {
      const vx = verts.getX(i);
      const vy = verts.getY(i);
      const vz = verts.getZ(i);
      const s = new THREE.Mesh((this as any)._handleGeom, (this as any)._handleMaterial.clone());
      s.position.set(vx, vy, vz).applyMatrix4(this.planeMesh.matrixWorld);
      s.userData['cornerIndex'] = i;
      this.scene.add(s);
      this.cornerSpheres.push(s);
    }

    this.transform.attach(this.planeMesh);
  }

  private updateHandlesFromPlane() {
    if (!this.planeMesh) return;
    const pos = this.planeMesh.geometry.attributes['position'];
    for (let i = 0; i < 4; i++) {
      const local = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const world = local.clone().applyMatrix4(this.planeMesh.matrixWorld);
      this.cornerSpheres[i].position.copy(world);
    }
  }

  private updatePlaneFromHandles() {
    if (!this.planeMesh) return;
    const pos = this.planeMesh.geometry.attributes['position'];
    for (let i = 0; i < 4; i++) {
      const world = this.cornerSpheres[i].position.clone();
      const local = world.applyMatrix4(new THREE.Matrix4().copy(this.planeMesh.matrixWorld).invert());
      pos.setXYZ(i, local.x, local.y, local.z);
    }
    pos.needsUpdate = true;
    this.planeMesh.geometry.computeVertexNormals();
  }

  setMode(m: 'select' | 'distort') {
    this.mode = m;
    this.cornerSpheres.forEach(s => s.visible = (m === 'distort'));
    this.transform.enabled = (m === 'select');
    this.orbit.enabled = true;
  }

  flip(axis: 'x' | 'y') {
    if (!this.planeMesh) return;
    if (axis === 'x') this.planeMesh.scale.x *= -1; else this.planeMesh.scale.y *= -1;
  }

  async loadSample() {
    const url = 'https://images.unsplash.com/photo-1519710164239-da123dc03ef4?w=1600&q=80';
    await this.loadTexture(url);
  }

  async onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const f = input.files && input.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    await this.loadTexture(url);
    URL.revokeObjectURL(url);
    input.value = '';
  }

  private loadTexture(url: string) {
    return new Promise<void>((resolve, reject) => {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.needsUpdate = true;
        this.createPlane(tex);
        this.cornerSpheres.forEach(s => s.visible = (this.mode === 'distort'));
        this.updateHandlesFromPlane();
        resolve();
      }, undefined, reject);
    });
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.orbit.update();
    this.updateHandlesFromPlane();
    this.renderer.render(this.scene, this.camera);
  }

  private onResize = () => {
    const wrap = this.canvasWrap.nativeElement;
    this.camera.aspect = wrap.clientWidth / wrap.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(wrap.clientWidth, wrap.clientHeight);
  }

  private disposeAll() {
    if (this.renderer) {
      this.renderer.dispose();
      (this.renderer.domElement.parentNode as any)?.removeChild(this.renderer.domElement);
    }
  }
}

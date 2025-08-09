import {
  Component, ElementRef, ViewChild, AfterViewInit, OnDestroy
} from '@angular/core';

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

@Component({
  selector: 'app-board',
  templateUrl: './board.component.html',
  styleUrls: ['./board.component.scss']
})
export class BoardComponent implements AfterViewInit, OnDestroy {

  @ViewChild('canvasWrapper', { static: true }) canvasWrapper!: ElementRef<HTMLDivElement>;

  private scene!: THREE.Scene;
  private camera!: THREE.OrthographicCamera;
  private renderer!: THREE.WebGLRenderer;
  private transformControls!: TransformControls;


  meshes: THREE.Mesh[] = [];
  selectedMesh: THREE.Mesh | null = null;

  tool: 'move' | 'scale' | 'rotate' | 'distort' = 'move';

  // Для дисторшна
  private cornerSpheres: THREE.Mesh[] = [];
  private draggingCorner: THREE.Mesh | null = null;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private dragOffset = new THREE.Vector3();

  private isDragging = false;

  ngAfterViewInit(): void {
    this.initThree();
    this.animate();
    window.addEventListener('resize', this.onResize);
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.dispose();
  }

  private initThree() {
    const width = this.canvasWrapper.nativeElement.clientWidth;
    const height = this.canvasWrapper.nativeElement.clientHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.OrthographicCamera(0, width, height, 0, -1000, 1000);
    this.camera.position.z = 10;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.canvasWrapper.nativeElement.appendChild(this.renderer.domElement);

    // TransformControls
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.addEventListener('dragging-changed', (event) => {
      this.isDragging = !!event.value;
    });
    this.scene.add(this.transformControls.getHelper());

    this.setupInteraction();
  }

  private setupInteraction() {
    const dom = this.renderer.domElement;
    dom.style.touchAction = 'none';

    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  private removeInteraction() {
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  private onPointerDown = (event: PointerEvent) => {
    if (this.isDragging || this.transformControls.dragging) {
      // Трансформация в процессе — игнорируем выбор
      return;
    }

    if (this.tool !== 'distort') {
      // Если включен инструмент move/scale/rotate, то выбираем меш только если клик не по контролу
      if (this.transformControls.dragging) return; // игнорируем если контролы захватывают событие
    }

    if (this.tool === 'distort' && this.selectedMesh) {
      this.updateMouse(event);
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.cornerSpheres);
      if (intersects.length > 0) {
        this.draggingCorner = intersects[0].object as THREE.Mesh;
        this.dragOffset.copy(intersects[0].point).sub(this.draggingCorner.position);
        return;
      }
    }

    // Если не дисторшн, кликаем по слоям для выбора
    this.updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.meshes.slice().reverse()); // Сверху вниз
    if (intersects.length > 0) {
      this.selectMesh(intersects[0].object as THREE.Mesh);
    } else {
      this.selectMesh(null);
    }
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.tool === 'distort' && this.draggingCorner) {
      this.updateMouse(event);
      this.raycaster.setFromCamera(this.mouse, this.camera);

      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const intersectPoint = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(plane, intersectPoint);

      if (!intersectPoint) return;
      const newPos = intersectPoint.sub(this.dragOffset);

      this.draggingCorner.position.copy(newPos);
      this.updateDistort();
    }
  }

  private onPointerUp = () => {
    this.draggingCorner = null;
  }

  private updateMouse(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  onFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;

    Array.from(input.files).forEach(file => {
      const url = URL.createObjectURL(file);
      new THREE.TextureLoader().load(url, (texture) => {
        this.addImageLayer(texture, file.name);
        URL.revokeObjectURL(url);
      });
    });
    input.value = '';
  }

  private addImageLayer(texture: THREE.Texture, name?: string) {
    const wrap = this.canvasWrapper.nativeElement;
    const w = wrap.clientWidth / 3;
    const h = wrap.clientHeight / 3;

    const geo = new THREE.PlaneGeometry(w, h, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(wrap.clientWidth / 2, wrap.clientHeight / 2, this.meshes.length * 10);
    mesh.userData['name'] = name || 'Image';
    this.scene.add(mesh);

    this.meshes.push(mesh);
    this.selectMesh(mesh);
  }

  selectMesh(mesh: THREE.Mesh | null) {
    if (this.selectedMesh === mesh) return;

    // Снять предыдущие контролы и углы
    this.clearTransform();
    this.selectedMesh = mesh;

    if (mesh) {
      if (this.tool === 'distort') {
        this.initDistort(mesh);
      } else {
        this.initTransform(mesh);
      }
    }
  }

  private clearTransform() {
    this.transformControls.detach();
    this.clearDistort();
  }

  private initTransform(mesh: THREE.Mesh) {
    this.clearDistort();
    this.transformControls.attach(mesh);

    switch (this.tool) {
      case 'move': this.transformControls.setMode('translate'); break;
      case 'scale': this.transformControls.setMode('scale'); break;
      case 'rotate': this.transformControls.setMode('rotate'); break;
    }
  }

  private initDistort(mesh: THREE.Mesh) {
    this.transformControls.detach();
    this.createDistortHandles(mesh);
  }

  private createDistortHandles(mesh: THREE.Mesh) {
    this.clearDistort();
    // Создаем 4 угловых сферы, позиционируем по углам геометрии

    const geo = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.attributes['position'] as THREE.BufferAttribute;

    // Вершины плоскости
    // Инициализируем углы по позиции вершин геометрии в мировых координатах
    for (let i = 0; i < 4; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const localPos = new THREE.Vector3(x, y, 0);
      const worldPos = localPos.applyMatrix4(mesh.matrixWorld);

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(10, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffaa00 })
      );
      sphere.position.copy(worldPos);
      sphere.userData['cornerIndex'] = i;
      this.scene.add(sphere);
      this.cornerSpheres.push(sphere);
    }
  }

  private clearDistort() {
    this.cornerSpheres.forEach(s => {
      this.scene.remove(s);
      s.geometry.dispose();
      (s.material as THREE.Material).dispose();
    });
    this.cornerSpheres = [];
  }

  private updateDistort() {
    if (!this.selectedMesh || this.cornerSpheres.length !== 4) return;
    const geo = this.selectedMesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.attributes['position'] as THREE.BufferAttribute;

    // cornerSpheres: [0..3] — мир координаты углов, нужно преобразовать в локальные координаты mesh
    for (let i = 0; i < 4; i++) {
      const sphere = this.cornerSpheres[i];
      const localPos = sphere.position.clone();
      this.selectedMesh.worldToLocal(localPos);
      posAttr.setXYZ(i, localPos.x, localPos.y, localPos.z);
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  setTool(tool: 'move' | 'scale' | 'rotate' | 'distort') {
    if (this.tool === tool) return;
    this.tool = tool;
    if (this.selectedMesh) {
      if (tool === 'distort') {
        this.initDistort(this.selectedMesh);
      } else {
        this.initTransform(this.selectedMesh);
      }
    } else {
      this.transformControls.detach();
      this.clearDistort();
    }
  }

  flipSelected(axis: 'x' | 'y') {
    if (!this.selectedMesh) return;
    if (axis === 'x') this.selectedMesh.scale.x *= -1;
    else this.selectedMesh.scale.y *= -1;
  }

  deleteSelected() {
    if (!this.selectedMesh) return;

    this.clearTransform();
    this.scene.remove(this.selectedMesh);
    const index = this.meshes.indexOf(this.selectedMesh);
    if (index >= 0) this.meshes.splice(index, 1);

    this.selectedMesh = null;
  }

  moveLayerUp() {
    if (!this.selectedMesh) return;
    const index = this.meshes.indexOf(this.selectedMesh);
    if (index < this.meshes.length - 1) {
      this.swapLayers(index, index + 1);
    }
  }

  moveLayerDown() {
    if (!this.selectedMesh) return;
    const index = this.meshes.indexOf(this.selectedMesh);
    if (index > 0) {
      this.swapLayers(index, index - 1);
    }
  }

  private swapLayers(i1: number, i2: number) {
    const m1 = this.meshes[i1];
    const m2 = this.meshes[i2];

    // Меняем z-позиции (слой)
    const tempZ = m1.position.z;
    m1.position.z = m2.position.z;
    m2.position.z = tempZ;

    // Меняем местами в массиве
    this.meshes[i1] = m2;
    this.meshes[i2] = m1;
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.camera);
  }

  private onResize = () => {
    const w = this.canvasWrapper.nativeElement.clientWidth;
    const h = this.canvasWrapper.nativeElement.clientHeight;
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private dispose() {
    this.removeInteraction();
    this.transformControls.dispose();
    this.meshes.forEach(m => {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this.scene.remove(m);
    });
    this.meshes = [];
    this.clearDistort();
    if (this.renderer) {
      this.renderer.dispose();
      this.canvasWrapper.nativeElement.removeChild(this.renderer.domElement);
    }
  }
}

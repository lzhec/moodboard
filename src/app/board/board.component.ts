import {
  Component, ElementRef, ViewChild, AfterViewInit, OnDestroy,
  ChangeDetectionStrategy
} from '@angular/core';

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

@Component({
  selector: 'app-board',
  templateUrl: './board.component.html',
  styleUrls: ['./board.component.scss'],
  // changeDetection: ChangeDetectionStrategy.OnPush,
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

  private resizeTimeout: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit(): void {
    this.initThree();

    const wrapper = this.canvasWrapper.nativeElement;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;

    this.updateCamera(w, h);

    window.addEventListener('resize', this.onResize);
    this.render();  // отрисовать первый кадр
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

    // Добавляем слушатели один раз
    this.transformControls.addEventListener('dragging-changed', (event) => {
      // При начале или окончании перетаскивания — рендерим
      this.render();
    });

    this.transformControls.addEventListener('objectChange', () => {
      if (!this.selectedMesh) return;

      if (this.tool === 'move') {
        this.selectedMesh.position.z = 0;
      }

      if (this.tool === 'rotate') {
        this.selectedMesh.rotation.x = 0;
        this.selectedMesh.rotation.y = 0;
      }

      if (this.tool === 'scale') {
        this.selectedMesh.scale.z = 1;
      }

      this.render();
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

  // Чтобы корректно удалить слушатели, сделаем их методами класса:

  private onDraggingChanged = (event: any) => {
    this.render();
  }

  private onObjectChange = () => {
    if (!this.selectedMesh) return;

    if (this.tool === 'move') {
      this.selectedMesh.position.z = 0;
    }

    if (this.tool === 'rotate') {
      this.selectedMesh.rotation.x = 0;
      this.selectedMesh.rotation.y = 0;
    }

    if (this.tool === 'scale') {
      this.selectedMesh.scale.z = 1;
    }

    this.render();
  }

  private onPointerDown = (event: PointerEvent) => {
    this.updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // 1. Проверяем, попадает ли клик в cornerSpheres для distort
    if (this.tool === 'distort' && this.selectedMesh) {
      const cornerIntersects = this.raycaster.intersectObjects(this.cornerSpheres, false);
      if (cornerIntersects.length > 0) {
        this.draggingCorner = cornerIntersects[0].object as THREE.Mesh;

        const intersectPoint = cornerIntersects[0].point.clone();
        const localIntersect = this.selectedMesh.worldToLocal(intersectPoint);
        this.dragOffset.copy(localIntersect).sub(this.draggingCorner.position);

        return;
      }
    }

    // 2. Проверяем, пересекается ли выбранный меш под курсором
    if (this.selectedMesh) {
      const selectedIntersects = this.raycaster.intersectObject(this.selectedMesh, false);
      if (selectedIntersects.length > 0) {
        // Кликнули по выбранному слою — ничего менять не нужно
        return;
      }
    }

    // 3. Если клик не по выбранному слою, ищем любой меш под курсором
    const intersects = this.raycaster.intersectObjects(this.meshes, false);
    if (intersects.length > 0) {
      console.log('Выбран меш:', intersects[0].object);
      // Просто выбираем первый пересеченный меш
      this.selectMesh(intersects[0].object as THREE.Mesh);
    } else {
      // Если ничего не выбрали — снимаем выбор
      this.selectMesh(null);
    }
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.tool === 'distort' && this.draggingCorner && this.selectedMesh) {
      this.updateMouse(event);
      this.raycaster.setFromCamera(this.mouse, this.camera);

      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const intersectPoint = new THREE.Vector3();

      if (!this.raycaster.ray.intersectPlane(plane, intersectPoint)) return;

      // Преобразуем мировую точку в локальные координаты меша
      const localPos = this.selectedMesh.worldToLocal(intersectPoint.clone());

      // Вычитаем оффсет (в локальных координатах)
      const newLocalPos = localPos.sub(this.dragOffset);

      newLocalPos.z = 0; // чтобы плоскость оставалась XY

      this.draggingCorner.position.copy(newLocalPos);

      this.updateDistort();
      this.render();
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
    const segments = 10;
    const geo = new THREE.PlaneGeometry(w, h, segments, segments);

    // Сохраняем параметры, чтобы потом использовать
    geo.userData = {
      widthSegments: segments,
      heightSegments: segments
    };

    const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(wrap.clientWidth / 2, wrap.clientHeight / 2, this.meshes.length * 10);
    mesh.userData['name'] = name || 'Image';
    this.scene.add(mesh);

    this.meshes.push(mesh);
    this.selectMesh(mesh);

    this.render();
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

    // if (mesh) {
    //   if (this.tool === 'distort') {
    //     this.initDistort(mesh);
    //   } else {
    //     this.transformControls.attach(mesh);
    //     this.transformControls.setMode(this.tool === 'move' ? 'translate' : this.tool === 'scale' ? 'scale' : 'rotate');
    //   }
    // } else {
    //   this.transformControls.detach();
    //   this.clearDistort();
    // }

    this.render();
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

    this.transformControls.showX = true;
    this.transformControls.showY = true;
    this.transformControls.showZ = true;

    // Внимание: слушатель objectChange больше не добавляем здесь
  }

  private initDistort(mesh: THREE.Mesh) {
    this.transformControls.detach();
    this.createDistortHandles(mesh);
  }

  private createDistortHandles(mesh: THREE.Mesh) {
    this.clearDistort();

    mesh.updateMatrixWorld(true);

    const geo = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.attributes['position'] as THREE.BufferAttribute;

    const userData = geo.userData as { widthSegments: number; heightSegments: number };
    const segmentsX = userData?.widthSegments + 1 || 11;
    const segmentsY = userData?.heightSegments + 1 || 11;

    // Индексы 4 углов
    const cornerIndices = [
      0,                           // верхний левый
      segmentsX - 1,               // верхний правый
      segmentsX * segmentsY - 1,   // нижний правый
      segmentsX * (segmentsY - 1)  // нижний левый
    ];

    // Чистим массив
    this.cornerSpheres = [];

    for (let i = 0; i < 4; i++) {
      const idx = cornerIndices[i];
      const x = posAttr.getX(idx);
      const y = posAttr.getY(idx);
      const localPos = new THREE.Vector3(x, y, 0);

      const worldPos = localPos.clone().applyMatrix4(mesh.matrixWorld);

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(10, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffaa00 })
      );
      sphere.position.copy(worldPos);
      sphere.userData['cornerIndex'] = i;

      // Добавляем сферу в сцену
      this.scene.add(sphere);
      this.cornerSpheres.push(sphere);
    }

    this.render();
  }

  private clearDistort() {
    this.cornerSpheres.forEach(s => {
      this.scene.remove(s);
      s.geometry.dispose();
      (s.material as THREE.Material).dispose();
    });
    this.cornerSpheres = [];
    this.render();
  }

  private updateDistort() {
    if (!this.selectedMesh || this.cornerSpheres.length !== 4) return;
    const geo = this.selectedMesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.attributes['position'] as THREE.BufferAttribute;

    // Четыре угла — сферы в мировой системе
    const c0 = this.cornerSpheres[0].position;
    const c1 = this.cornerSpheres[1].position;
    const c2 = this.cornerSpheres[2].position;
    const c3 = this.cornerSpheres[3].position;

    const userData: { widthSegments: number; heightSegments: number } = geo.userData as { widthSegments: number; heightSegments: number };
    const segmentsX = userData.widthSegments + 1;
    const segmentsY = userData.heightSegments + 1;

    // Получаем позицию меша
    const meshPos = this.selectedMesh.position;

    for (let y = 0; y < segmentsY; y++) {
      const t = y / (segmentsY - 1);
      const left = new THREE.Vector3().lerpVectors(c0, c3, t);
      const right = new THREE.Vector3().lerpVectors(c1, c2, t);

      for (let x = 0; x < segmentsX; x++) {
        const s = x / (segmentsX - 1);
        const posWorld = new THREE.Vector3().lerpVectors(left, right, s);

        // Переводим из мировой системы в локальную (позиция вершины относительно меша)
        const posLocal = posWorld.clone().sub(meshPos);

        posAttr.setXYZ(y * segmentsX + x, posLocal.x, posLocal.y, posLocal.z);
      }
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
        // this.transformControls.attach(this.selectedMesh);
        // this.transformControls.setMode(tool === 'move' ? 'translate' : tool === 'scale' ? 'scale' : 'rotate');
      }
    } else {
      this.transformControls.detach();
      this.clearDistort();
    }

    this.render();
  }

  flipSelected(axis: 'x' | 'y') {
    if (!this.selectedMesh) {
      return
    };

    if (axis === 'x') {
      this.selectedMesh.scale.x *= -1;
    } else {
      this.selectedMesh.scale.y *= -1;
    }

    this.render();
  }

  deleteSelected() {
    if (!this.selectedMesh) return;

    this.clearTransform();
    this.scene.remove(this.selectedMesh);
    const index = this.meshes.indexOf(this.selectedMesh);
    if (index >= 0) this.meshes.splice(index, 1);

    this.selectedMesh = null;

    this.render();
  }

  moveLayerUp() {
    if (!this.selectedMesh) {
      return;
    }

    const index = this.meshes.indexOf(this.selectedMesh);

    if (index < this.meshes.length - 1) {
      this.swapLayers(index, index + 1);
      this.render();
    }
  }

  moveLayerDown() {
    if (!this.selectedMesh) {
      return;
    }

    const index = this.meshes.indexOf(this.selectedMesh);

    if (index > 0) {
      this.swapLayers(index, index - 1);
      this.render();
    }
  }

  private swapLayers(i1: number, i2: number) {
    const m1 = this.meshes[i1];
    const m2 = this.meshes[i2];

    const tempZ = m1.position.z;
    m1.position.z = m2.position.z;
    m2.position.z = tempZ;

    this.meshes[i1] = m2;
    this.meshes[i2] = m1;
  }

  private render() {
    this.renderer.render(this.scene, this.camera);
  }

  private onResize = () => {
    const wrapper = this.canvasWrapper.nativeElement;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;

    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();

    // Ограничиваем pixel ratio для предотвращения чрезмерной нагрузки
    const maxPixelRatio = 2; // можно уменьшить, если нужно
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.render();

    // if (this.resizeTimeout) {
    //   clearTimeout(this.resizeTimeout);
    // }

    // this.resizeTimeout = setTimeout(() => {
    //   const wrapper = this.canvasWrapper.nativeElement;
    //   const w = wrapper.clientWidth;
    //   const h = wrapper.clientHeight;

    //   this.camera.left = 0;
    //   this.camera.right = w;
    //   this.camera.top = h;
    //   this.camera.bottom = 0;
    //   this.camera.updateProjectionMatrix();

    //   this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    //   this.renderer.setSize(w, h, false);

    //   this.render();
    // }, 100);
  }

  private updateCamera(w: number, h: number) {
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  private dispose() {
    this.removeInteraction();

    // Убираем все слушатели transformControls перед dispose
    this.transformControls.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.transformControls.removeEventListener('objectChange', this.onObjectChange);

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

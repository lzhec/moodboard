import {
  Component, ElementRef, ViewChild, AfterViewInit, OnDestroy,
  ChangeDetectionStrategy
} from '@angular/core';

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ResizeBoxControls } from './controls/controls';

@Component({
  selector: 'app-board',
  templateUrl: './board.component.html',
  styleUrls: ['./board.component.scss'],
  // changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardComponent implements AfterViewInit, OnDestroy {

  @ViewChild('canvasWrapper', { static: true }) public canvasWrapper: ElementRef<HTMLDivElement>;

  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer;
  private transformControls: TransformControls;
  public meshes: THREE.Mesh[] = [];
  public selectedMesh: THREE.Mesh;
  public tool: 'move' | 'scale' | 'rotate' | 'distort' = 'move';

  // Для ресайза
  private resizeSpheres: THREE.Mesh[] = [];
  private resizingCorner: THREE.Mesh;
  private resizeDragOffset = new THREE.Vector3();
  private resizeStartSize = new THREE.Vector2();
  private resizeStartPos = new THREE.Vector3();
  private resizeStartMouse = new THREE.Vector2();
  private resizeControls!: ResizeBoxControls;
  private borderLines: THREE.LineLoop[] = [];

  // Для дисторшна
  private cornerSpheres: THREE.Mesh[] = [];
  private draggingCorner: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private dragOffset = new THREE.Vector3();

  // Для вращения
  private rotateHandle: THREE.Mesh;
  private isRotating = false;
  private rotateStartAngle = 0;
  private rotateLines: THREE.LineLoop[] = [];

  private resizeTimeout: ReturnType<typeof setTimeout>;
  private isPanning = false;
  private panStart = new THREE.Vector2();
  private panEnd = new THREE.Vector2();
  private panDelta = new THREE.Vector2();
  private isDraggingImage = false;
  private dragStartMouse = new THREE.Vector2();
  private dragStartPos = new THREE.Vector3();

  public ngAfterViewInit(): void {
    this.initThree();

    const wrapper = this.canvasWrapper.nativeElement;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;

    this.updateCamera(w, h);

    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('resize', this.onResize);
    this.render();  // отрисовать первый кадр
  }

  public ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.renderer.domElement.removeEventListener('mousedown', this.onMouseDown);
    this.renderer.domElement.removeEventListener('wheel', this.onWheel);
    this.dispose();
  }

  private initThree(): void {
    const width = this.canvasWrapper.nativeElement.clientWidth;
    const height = this.canvasWrapper.nativeElement.clientHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.OrthographicCamera(0, width, height, 0, -1000, 1000);
    this.camera.position.z = 10;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.domElement.style.width = '100vw';
    this.renderer.domElement.style.height = '100vh';
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

      // Вызов обновления позиции ручек, если выбран scale
      if (this.tool === 'scale' && this.resizeControls) {
        this.resizeControls.updateHandlesPosition();
      }

      this.render();
    });

    this.resizeControls = new ResizeBoxControls(this.camera, this.renderer.domElement);
    this.resizeControls.onChange = () => this.render();

    this.scene.add(this.resizeControls);

    this.setupInteraction();
  }

  private setupInteraction(): void {
    const dom = this.renderer.domElement;
    dom.style.touchAction = 'none';

    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    this.renderer.domElement.addEventListener('mousedown', this.onMouseDown);
  }

  private removeInteraction(): void {
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.renderer.domElement.removeEventListener('mousedown', this.onMouseDown);
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();

    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Нормализуем координаты мыши от 0 до 1
    const normX = mouseX / rect.width;
    const normY = mouseY / rect.height;

    // Размеры текущей камеры
    const width = this.camera.right - this.camera.left;
    const height = this.camera.top - this.camera.bottom;

    // Текущие левые/верхние координаты камеры
    let left = this.camera.left;
    let bottom = this.camera.bottom;

    // Масштабный фактор (чем больше - тем сильнее зум)
    const zoomSpeed = 0.1;
    const delta = event.deltaY * (zoomSpeed / 100);

    // Ограничения масштаба
    const minWidth = 100;
    const maxWidth = 10000;

    // Новый размер камеры
    let newWidth = width * (1 + delta);
    newWidth = Math.min(Math.max(newWidth, minWidth), maxWidth);
    const newHeight = (height / width) * newWidth;

    // Рассчитаем новый left и bottom так, чтобы точка под курсором осталась неподвижной
    // Точка под курсором в мире:
    // worldX = left + normX * width
    // после масштабирования хотим:
    // worldX = newLeft + normX * newWidth => newLeft = worldX - normX * newWidth

    const worldX = left + normX * width;
    const worldY = bottom + normY * height;

    const newLeft = worldX - normX * newWidth;
    const newBottom = worldY - normY * newHeight;

    // Обновляем камеру
    this.camera.left = newLeft;
    this.camera.right = newLeft + newWidth;
    this.camera.bottom = newBottom;
    this.camera.top = newBottom + newHeight;
    this.camera.updateProjectionMatrix();

    this.render();
  };

  private onMouseDown = (event: MouseEvent) => {
    // Например, срабатываем на зажатие средней кнопки мыши
    if (event.button === 1) {
      event.preventDefault();
      this.isPanning = true;
      this.panStart.set(event.clientX, event.clientY);
    } else if (this.tool === 'rotate' && this.rotateHandle) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      // Создаем вектор мыши в нормализованных координатах
      const mouse = new THREE.Vector2(
        (mouseX / rect.width) * 2 - 1,
        -(mouseY / rect.height) * 2 + 1
      );

      // Настраиваем raycaster с текущей камерой
      this.raycaster.setFromCamera(mouse, this.camera);

      // Проверяем пересечение с ручкой вращения
      const intersects = this.raycaster.intersectObject(this.rotateHandle);

      if (intersects.length > 0) {
        this.isRotating = true;
        this.rotateStartAngle = this.calculateRotationAngle(event);
        event.preventDefault();
        return;
      }
    }
  }

  private onMouseMove = (event: MouseEvent) => {
    // Проверяем, что мы в режиме поворота и идет процесс вращения
    // if (this.tool === 'rotate' && this.isRotating && this.selectedMesh) {
    //   const currentAngle = this.calculateRotationAngle(event);
    //   const angleDelta = currentAngle - this.rotateStartAngle;

    //   console.log('Rotation details:', {
    //     angleDelta: angleDelta,
    //     currentAngle: currentAngle,
    //     rotateStartAngle: this.rotateStartAngle,
    //     meshPosition: this.selectedMesh.position.clone(),
    //     meshRotation: this.selectedMesh.rotation.clone()
    //   });

    //   // Используем более надежный метод поворота
    //   this.selectedMesh.rotateOnAxis(new THREE.Vector3(0, 0, 1), angleDelta);

    //   this.rotateStartAngle = currentAngle;

    //   // Обновляем позицию ручки поворота
    //   if (this.rotateHandle) {
    //     const bbox = new THREE.Box3().setFromObject(this.selectedMesh);
    //     const center = bbox.getCenter(new THREE.Vector3());
    //     const size = bbox.getSize(new THREE.Vector3());

    //     this.rotateHandle.position.set(
    //       center.x,
    //       center.y + size.y / 2 + 50,
    //       center.z
    //     );
    //   }

    //   this.render();
    //   return;
    // }

    if (!this.isPanning) return;

    this.panEnd.set(event.clientX, event.clientY);
    this.panDelta.subVectors(this.panEnd, this.panStart);

    // Скорость панорамирования (настрой)
    const panSpeed = 1;

    // Поскольку у камеры ортографическая проекция, сдвигаем положение и границы камеры
    this.camera.position.x -= this.panDelta.x * panSpeed;
    this.camera.position.y += this.panDelta.y * panSpeed;

    this.camera.left -= this.panDelta.x * panSpeed;
    this.camera.right -= this.panDelta.x * panSpeed;
    this.camera.top += this.panDelta.y * panSpeed;
    this.camera.bottom += this.panDelta.y * panSpeed;

    this.camera.updateProjectionMatrix();

    this.panStart.copy(this.panEnd);

    this.render();
  }

  private onMouseUp = (event: MouseEvent) => {
    if (event.button === 1 && this.isPanning) {
      this.isPanning = false;
    }

    if (this.tool === 'rotate') {
      this.isRotating = false;
    }
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

    // 1. Проверяем, попадает ли клик в ручки ресайза
    if (this.tool === 'scale' && this.selectedMesh) {
      const resizeIntersects = this.raycaster.intersectObjects(this.resizeSpheres, false);
      if (resizeIntersects.length > 0) {
        this.resizingCorner = <THREE.Mesh>resizeIntersects[0].object;

        // Запоминаем начальные параметры с учётом текущего scale
        const geo = <THREE.PlaneGeometry>this.selectedMesh.geometry;
        const originalWidth = geo.parameters.width;
        const originalHeight = geo.parameters.height;

        this.resizeStartSize.set(originalWidth * this.selectedMesh.scale.x, originalHeight * this.selectedMesh.scale.y);
        this.resizeStartPos.copy(this.selectedMesh.position);
        this.resizeStartMouse.set(event.clientX, event.clientY);

        return;
      }
    }

    // 2. Проверяем, попадает ли клик в cornerSpheres для distort
    if (this.tool === 'distort' && this.selectedMesh) {
      const cornerIntersects = this.raycaster.intersectObjects(this.cornerSpheres, false);
      if (cornerIntersects.length > 0) {
        this.draggingCorner = <THREE.Mesh>cornerIntersects[0].object;

        const intersectPoint = cornerIntersects[0].point.clone();
        this.selectedMesh.updateMatrixWorld(true);

        // всё переводим в ЛОКАЛЬНЫЕ координаты меша
        const localIntersect = this.selectedMesh.worldToLocal(intersectPoint.clone());
        const cornerLocal = this.selectedMesh.worldToLocal(this.draggingCorner.position.clone());

        // оффсет считаем в ЛОКАЛЕ
        this.dragOffset.copy(localIntersect).sub(cornerLocal);

        return;
      }
    }

    // 3. Проверяем, попадает ли клик в ротейт-ручку
    if (this.tool === 'rotate' && this.selectedMesh && this.rotateHandle) {
      const rotateIntersects = this.raycaster.intersectObject(this.rotateHandle);
      if (rotateIntersects.length > 0) {
        this.isRotating = true;
        this.rotateStartAngle = this.calculateRotationAngle(event);
        this.dragStartMouse.set(event.clientX, event.clientY);
        event.preventDefault();
        return;
      }
    }

    // 4. Проверяем, пересекается ли выбранный меш под курсором
    if (this.selectedMesh) {
      const selectedIntersects = this.raycaster.intersectObject(this.selectedMesh, false);
      if (selectedIntersects.length > 0) {
        if (this.tool === 'move') {
          this.isDraggingImage = true;
          this.dragStartMouse.set(event.clientX, event.clientY);
          this.dragStartPos.copy(this.selectedMesh.position);
          event.preventDefault();
        }
        return; // Кликнули по выбранному слою — ничего менять не нужно
      }
    }

    // 5. Если клик не по выбранному слою, ищем любой меш под курсором и выбираем
    const intersects = this.raycaster.intersectObjects(this.meshes, false);
    if (intersects.length > 0) {
      this.selectMesh(<THREE.Mesh>intersects[0].object);

      if (this.tool === 'move') {
        this.isDraggingImage = true;
        this.dragStartMouse.set(event.clientX, event.clientY);
        this.dragStartPos.copy(this.selectedMesh!.position);
        event.preventDefault();
      }
    } else {
      this.selectMesh(null);
    }
  }

  private onPointerMove = (event: PointerEvent) => {
    // Логика ресайза
    if (this.tool === 'scale' && this.resizingCorner && this.selectedMesh) {
      const dx = event.clientX - this.resizeStartMouse.x;
      const dy = event.clientY - this.resizeStartMouse.y;

      const wrapper = this.canvasWrapper.nativeElement;
      const wrapperWidth = wrapper.clientWidth;
      const wrapperHeight = wrapper.clientHeight;

      const cornerIndex = this.resizingCorner.userData['cornerIndex'];

      // Переводим движение мыши в изменение размера
      let deltaX = dx / wrapperWidth * this.resizeStartSize.x * 2;
      let deltaY = dy / wrapperHeight * this.resizeStartSize.y * 2;

      // Инвертируем для нужных углов
      switch (cornerIndex) {
        case 1: deltaX = -deltaX; break;           // левый нижний
        case 2: deltaX = -deltaX; deltaY = -deltaY; break; // правый нижний
        case 3: deltaY = -deltaY; break;           // правый верхний
      }

      // Новые размеры
      const newWidth = this.resizeStartSize.x + deltaX;
      const newHeight = this.resizeStartSize.y + deltaY;

      const geo = <THREE.PlaneGeometry>this.selectedMesh.geometry;
      const baseW = geo.parameters.width;
      const baseH = geo.parameters.height;

      this.selectedMesh.scale.x = newWidth / baseW;
      this.selectedMesh.scale.y = newHeight / baseH;

      // Корректируем позицию в зависимости от угла
      const positionAdjustment = this.calculatePositionAdjustment(
        cornerIndex,
        this.resizeStartPos,
        this.resizeStartSize,
        new THREE.Vector2(newWidth, newHeight)
      );
      this.selectedMesh.position.copy(positionAdjustment);

      // Обновляем ручки
      this.clearResizeHandles();
      this.createResizeHandles(this.selectedMesh);

      this.render();
      return;
    }

    // Проверяем, что мы в режиме поворота и идет процесс вращения
    if (this.tool === 'rotate' && this.isRotating && this.selectedMesh) {
      const rect = this.renderer.domElement.getBoundingClientRect();

      // Текущая позиция курсора
      const currentX = event.clientX - rect.left;
      const currentY = event.clientY - rect.top;

      // Начальная позиция курсора
      const startX = this.dragStartMouse.x - rect.left;
      const startY = this.dragStartMouse.y - rect.top;

      // Вычисляем углы для начальной и текущей позиций
      const startAngle = Math.atan2(startY - rect.height / 2, startX - rect.width / 2);
      const currentAngle = Math.atan2(currentY - rect.height / 2, currentX - rect.width / 2);

      // Рассчитываем разницу углов
      let angleDelta = currentAngle - startAngle;

      // Нормализация угла (предотвращение скачков через 360 градусов)
      if (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;
      if (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;

      // Коэффициент для точного контроля
      const rotationSpeed = 1.0;

      // Вращаем изображение точно на вычисленный угол
      this.selectedMesh.rotateOnAxis(new THREE.Vector3(0, 0, 1), angleDelta * rotationSpeed);

      // Обновляем начальную позицию мыши
      this.dragStartMouse.set(event.clientX, event.clientY);

      // Обновляем позицию ручки поворота
      if (this.rotateHandle) {
        const bbox = new THREE.Box3().setFromObject(this.selectedMesh);
        const size = bbox.getSize(new THREE.Vector3());

        this.rotateHandle.position.set(
          0, // По центру X
          size.y / 2 + 30, // Над верхним краем
          0 // По центру Z
        );
      }

      this.clearRotateHandles();
      this.createRotateHandle(this.selectedMesh);

      this.render();
    }

    // Логика дисторта
    if (this.tool === 'distort' && this.draggingCorner && this.selectedMesh) {
      this.updateMouse(event);
      this.raycaster.setFromCamera(this.mouse, this.camera);

      this.selectedMesh.updateMatrixWorld(true);

      // плоскость, СОПЛАНАРНАЯ мешу (учитывает его поворот/наклон)
      const normal = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(this.selectedMesh.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
      const planePoint = this.selectedMesh.getWorldPosition(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePoint);

      const intersectPoint = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(plane, intersectPoint)) return;

      // мировую точку -> в ЛОКАЛ меша
      const localPos = this.selectedMesh.worldToLocal(intersectPoint.clone());

      // учитываем оффсет (в ЛОКАЛЕ)
      const newLocalPos = localPos.sub(this.dragOffset);
      newLocalPos.z = 0;

      // обратно в МИР — и обновляем позицию ручки (она ребёнок сцены)
      const newWorldPos = this.selectedMesh.localToWorld(newLocalPos.clone());
      this.draggingCorner.position.copy(newWorldPos);

      this.updateDistort();
      this.render();
      return;
    }

    if (this.isDraggingImage && this.selectedMesh && this.tool === 'move') {
      const dx = event.clientX - this.dragStartMouse.x;
      const dy = event.clientY - this.dragStartMouse.y;

      const camWidth = this.camera.right - this.camera.left;
      const camHeight = this.camera.top - this.camera.bottom;

      const wrapper = this.canvasWrapper.nativeElement;
      const wrapperWidth = wrapper.clientWidth;
      const wrapperHeight = wrapper.clientHeight;

      // Переводим экранные пиксели в координаты мира
      const worldDx = dx * camWidth / wrapperWidth;
      const worldDy = -dy * camHeight / wrapperHeight;

      this.selectedMesh.position.set(
        this.dragStartPos.x + worldDx,
        this.dragStartPos.y + worldDy,
        this.selectedMesh.position.z
      );

      this.render();
      return;
    }
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.button === 0) {
      this.isDraggingImage = false;
      this.isRotating = false;
      this.draggingCorner = null;
      this.resizingCorner = null;  // Сбрасываем ресайз
    }
  }

  private updateMouse(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  public onFilesSelected(event: Event): void {
    const input = <HTMLInputElement>event.target;
    if (!input.files?.length) return;

    Array.from(input.files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const loader = new THREE.TextureLoader();
        loader.load(<string>e.target!.result, (texture) => {
          // Современные настройки текстуры
          texture.colorSpace = 'srgb'; // Используем строковое значение
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.generateMipmaps = false;
          texture.needsUpdate = true;

          const imgWidth = texture.image.width;
          const imgHeight = texture.image.height;
          const segments = 10;

          const geometry = new THREE.PlaneGeometry(imgWidth, imgHeight, segments, segments);

          geometry.userData = {
            widthSegments: segments,
            heightSegments: segments
          };

          const material = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.DoubleSide,
            transparent: true,
            // color: 0xffffff, // Белый цвет для максимальной яркости
            // opacity: 1.0 // Полная непрозрачность
          });

          const mesh = new THREE.Mesh(geometry, material);
          mesh.userData["name"] = file.name;
          mesh.userData['originalSize'] = {
            width: imgWidth,
            height: imgHeight,
          };

          this.addImageLayer(mesh);
        }, undefined, (error) => {
          console.error('Ошибка загрузки изображения', error);
        });
      };
      reader.readAsDataURL(file);
    });
  }

  private addImageLayer(mesh: THREE.Mesh): void {
    // Центрируем в середине экрана камеры
    const camWidth = this.camera.right - this.camera.left;
    const camHeight = this.camera.top - this.camera.bottom;
    mesh.position.set(this.camera.left + camWidth / 2, this.camera.bottom + camHeight / 2, 0);
    mesh.scale.set(1, 1, 1);

    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.selectMesh(mesh);

    this.render(); // Отрисовать сразу
  }

  public selectMesh(mesh: THREE.Mesh): void {
    if (this.selectedMesh === mesh) return;

    // Снимаем старые контролы и углы
    this.clearRotateHandles(this.selectedMesh);
    this.clearTransform();
    this.selectedMesh = mesh;

    if (mesh) {
      if (this.tool === 'distort') {
        this.initDistortHandles(mesh);
        this.clearResizeHandles();
        this.clearRotateHandles(mesh);
      } else if (this.tool === 'scale') {
        this.initResizeHandles(mesh);
        this.clearDistortHandles();
        this.clearRotateHandles(mesh);
      } else if (this.tool === 'rotate') {
        this.initRotateHandles(mesh);
        this.clearDistortHandles();
        this.clearResizeHandles();
      } else {
        this.clearResizeHandles();
        this.clearDistortHandles();
        this.clearRotateHandles(mesh);
        this.initTransform(mesh);
      }
    } else {
      this.resizeControls.setTarget(null);
      this.transformControls.detach();
      this.clearDistortHandles();
      this.clearRotateHandles(mesh);
      this.clearResizeHandles();
    }

    this.render();
  }

  private clearTransform(): void {
    this.transformControls.detach();
    this.clearDistortHandles();
  }

  private initTransform(mesh: THREE.Mesh): void {
    this.clearDistortHandles();
    this.transformControls.attach(mesh);

    switch (this.tool) {
      case 'move':
        this.transformControls.setMode('translate');
        break;

      // case 'scale':
      //   this.transformControls.setMode('scale');
      //   break;

      case 'rotate':
        this.transformControls.setMode('rotate');
        break;
    }

    this.transformControls.showX = true;
    this.transformControls.showY = true;
    this.transformControls.showZ = true;

    // Внимание: слушатель objectChange больше не добавляем здесь
  }

  private initDistortHandles(mesh: THREE.Mesh): void {
    this.transformControls.detach();
    this.createDistortHandles(mesh);
  }

  private initResizeHandles(mesh: THREE.Mesh): void {
    this.transformControls.detach();
    this.createResizeHandles(mesh);
  }

  private initRotateHandles(mesh: THREE.Mesh): void {
    this.transformControls.detach();
    this.createRotateHandle(mesh);
  }

  private createResizeHandles(mesh: THREE.Mesh): void {
    // Очистить предыдущие ручки
    this.clearResizeHandles();

    const bbox = new THREE.Box3().setFromObject(mesh);

    // Создаем массив векторов
    const corners: { x: number, y: number, z: number }[] = [
      { x: bbox.max.x, y: bbox.min.y, z: 0 }, // нижний правый
      { x: bbox.min.x, y: bbox.min.y, z: 0 }, // нижний левый
      { x: bbox.min.x, y: bbox.max.y, z: 0 }, // верхний левый
      { x: bbox.max.x, y: bbox.max.y, z: 0 }  // верхний правый
    ];

    // Рисуем бордер прямоугольника
    const borderMaterial = new THREE.LineBasicMaterial({
      color: 0x00aaff,
      linewidth: 2,
    });

    const borderGeometry = new THREE.BufferGeometry();
    const borderPoints = [
      new THREE.Vector3(corners[0].x, corners[0].y, corners[0].z),
      new THREE.Vector3(corners[1].x, corners[1].y, corners[1].z),
      new THREE.Vector3(corners[2].x, corners[2].y, corners[2].z),
      new THREE.Vector3(corners[3].x, corners[3].y, corners[3].z),
      new THREE.Vector3(corners[0].x, corners[0].y, corners[0].z) // Замыкаем прямоугольник
    ];

    borderGeometry.setFromPoints(borderPoints);

    const borderLine = new THREE.LineLoop(borderGeometry, borderMaterial);

    this.scene.add(borderLine);
    this.borderLines.push(borderLine);

    // Ручки по углам
    for (let i = 0; i < 4; i++) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(8, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x00aaff })
      );
      sphere.position.set(corners[i].x, corners[i].y, corners[i].z);
      sphere.userData['cornerIndex'] = i;

      this.scene.add(sphere);
      this.resizeSpheres.push(sphere);
    }

    this.render();
  }

  private createRotateHandle(mesh: THREE.Mesh): void {
    // Удаляем существующие бордеры и ручку
    this.clearRotateHandles(mesh);

    // Берем реальные размеры меша
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    const bbox = geo.boundingBox.clone(); // локальный bbox

    // Переводим bbox в мировые координаты
    bbox.applyMatrix4(mesh.matrixWorld);

    // Четыре угла
    const corners = [
      new THREE.Vector3(bbox.max.x, bbox.min.y, 0), // нижний правый
      new THREE.Vector3(bbox.min.x, bbox.min.y, 0), // нижний левый
      new THREE.Vector3(bbox.min.x, bbox.max.y, 0), // верхний левый
      new THREE.Vector3(bbox.max.x, bbox.max.y, 0), // верхний правый
    ];

    // Создание бордера
    const borderMaterial = new THREE.LineBasicMaterial({
      color: 0xff0000,  // Другой цвет для отличия
      linewidth: 2
    });

    const borderGeometry = new THREE.BufferGeometry().setFromPoints([
      corners[0], corners[1], corners[2], corners[3], corners[0]
    ]);

    const borderLine = new THREE.LineLoop(borderGeometry, borderMaterial);
    borderLine.name = 'rotate-border';
    borderLine.renderOrder = 1000;
    // borderLine.position.set(0, 0, 0);

    this.scene.add(borderLine);
    this.rotateLines.push(borderLine);

    // Ручка
    const geometry = new THREE.CircleGeometry(30, 32);
    const material = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.5, depthTest: false });
    this.rotateHandle = new THREE.Mesh(geometry, material);
    this.rotateHandle.name = 'rotate-handle';
    this.rotateHandle.renderOrder = 1000;

    // Позиционируем ручку над верхним краем bounding box
    const bboxHeight = bbox.max.y - bbox.min.y;
    this.rotateHandle.position.set(
      0,               // по центру X
      bboxHeight / 2 + 30, // над верхним краем
      0                // по центру Z
    );

    // Добавляем ручку как дочерний объект меша
    mesh.add(this.rotateHandle);

    this.render();
  }

  private createDistortHandles(mesh: THREE.Mesh): void {
    this.clearDistortHandles();

    mesh.updateMatrixWorld(true);

    const geo = <THREE.BufferGeometry>mesh.geometry;
    const posAttr = <THREE.BufferAttribute>geo.attributes['position'];

    const userData: { widthSegments: number; heightSegments: number } = <{ widthSegments: number; heightSegments: number }>geo.userData;
    const segmentsX = userData.widthSegments + 1;
    const segmentsY = userData.heightSegments + 1;

    // Точные индексы углов в исходной геометрии
    const cornerIndices = [
      0,                           // верхний левый
      segmentsX - 1,               // верхний правый
      segmentsX * segmentsY - 1,   // нижний правый
      segmentsX * (segmentsY - 1)  // нижний левый
    ];

    this.cornerSpheres = cornerIndices.map((idx, i) => {
      // Получаем локальные координаты угловой вершины
      const localX = posAttr.getX(idx);
      const localY = posAttr.getY(idx);
      const localPos = new THREE.Vector3(localX, localY, 0);

      // Преобразуем в мировые координаты с учетом всех трансформаций
      const worldPos = localPos.clone().applyMatrix4(mesh.matrixWorld);

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(10, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffaa00 })
      );
      sphere.position.copy(worldPos);
      sphere.userData['cornerIndex'] = i;
      sphere.userData['originalLocalPosition'] = localPos.clone(); // Сохраняем оригинальную локальную позицию

      this.scene.add(sphere);
      return sphere;
    });

    this.render();
  }

  private clearDistortHandles(): void {
    this.cornerSpheres.forEach(s => {
      this.scene.remove(s);
      s.geometry.dispose();
      (<THREE.Material>s.material).dispose();
    });
    this.cornerSpheres = [];
    this.render();
  }

  private clearResizeHandles(): void {
    // Удаление бордеров
    this.borderLines.forEach(line => {
      this.scene.remove(line);
      line.geometry.dispose();
      (<THREE.Material>line.material).dispose();
    });
    this.borderLines = [];

    // Удаление сфер
    this.resizeSpheres.forEach(s => {
      this.scene.remove(s);
      s.geometry.dispose();
      (<THREE.Material>s.material).dispose();
    });
    this.resizeSpheres = [];
    this.render();
  }

  private clearRotateHandles(mesh: THREE.Mesh = null): void {
    this.rotateLines.forEach(line => {
      this.scene.remove(line);
      line.geometry.dispose();
      (<THREE.Material>line.material).dispose();
    });

    this.rotateLines = [];

    if (this.rotateHandle) {
      if (this.selectedMesh) {
        this.selectedMesh.remove(this.rotateHandle);
      }

      this.scene.remove(this.rotateHandle);
      this.rotateHandle = null;
    }

    this.scene.remove(<THREE.Mesh>this.rotateHandle);
    this.rotateHandle?.geometry.dispose();
    (<THREE.Material>this.rotateHandle?.material)?.dispose();
    this.render();
  }

  private calculatePositionAdjustment(
    cornerIndex: number,
    startPos: THREE.Vector3,
    startSize: THREE.Vector2,
    newSize: THREE.Vector2
  ): THREE.Vector3 {
    const dx = (newSize.x - startSize.x) / 2;
    const dy = (newSize.y - startSize.y) / 2;

    switch (cornerIndex) {
      case 0: // верхний левый
        return new THREE.Vector3(
          startPos.x + dx,
          startPos.y - dy,
          startPos.z
        );
      case 1: // верхний правый
        return new THREE.Vector3(
          startPos.x - dx,
          startPos.y - dy,
          startPos.z
        );
      case 2: // нижний правый
        return new THREE.Vector3(
          startPos.x - dx,
          startPos.y + dy,
          startPos.z
        );
      case 3: // нижний левый
        return new THREE.Vector3(
          startPos.x + dx,
          startPos.y + dy,
          startPos.z
        );
      default:
        return startPos;
    }
  }

  private calculateRotationAngle(event: MouseEvent): number {
    if (!this.selectedMesh || !this.rotateHandle) return 0;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Получаем позицию ротейт-ручки
    const handleWorldPos = new THREE.Vector3();
    this.rotateHandle.getWorldPosition(handleWorldPos);

    // Создаем вектор мыши в нормализованных координатах
    const mouse = new THREE.Vector2(
      (mouseX / rect.width) * 2 - 1,
      -(mouseY / rect.height) * 2 + 1
    );

    // Настраиваем raycaster с текущей камерой
    this.raycaster.setFromCamera(mouse, this.camera);

    // Получаем позицию мыши в мировых координатах
    const worldPoint = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1)), worldPoint);

    // Вычисляем угол относительно центра ротейт-ручки
    const angle = Math.atan2(
      worldPoint.y - handleWorldPos.y,
      worldPoint.x - handleWorldPos.x
    );

    return angle;
  }

  private updateDistort(): void {
    if (!this.selectedMesh || this.cornerSpheres.length !== 4) return;
    const geo = <THREE.BufferGeometry>this.selectedMesh.geometry;
    const posAttr = <THREE.BufferAttribute>geo.attributes['position'];

    const userData: { widthSegments: number; heightSegments: number } = <{ widthSegments: number; heightSegments: number }>geo.userData;
    const segmentsX = userData.widthSegments + 1;
    const segmentsY = userData.heightSegments + 1;

    // Получаем текущие позиции сфер в мировых координатах
    const worldCorners = this.cornerSpheres.map(sphere => sphere.position.clone());

    // Создаем обратную матрицу для преобразования
    const inverseMatrix = new THREE.Matrix4().copy(this.selectedMesh.matrixWorld).invert();

    // Получаем оригинальные локальные позиции углов
    const originalCorners = [
      new THREE.Vector3(posAttr.getX(0), posAttr.getY(0), 0),
      new THREE.Vector3(posAttr.getX(segmentsX - 1), posAttr.getY(segmentsX - 1), 0),
      new THREE.Vector3(posAttr.getX(segmentsX * segmentsY - 1), posAttr.getY(segmentsX * segmentsY - 1), 0),
      new THREE.Vector3(posAttr.getX(segmentsX * (segmentsY - 1)), posAttr.getY(segmentsX * (segmentsY - 1)), 0)
    ];

    // Интерполируем все вершины
    for (let y = 0; y < segmentsY; y++) {
      const t = y / (segmentsY - 1);
      const left = new THREE.Vector3().lerpVectors(worldCorners[0], worldCorners[3], t);
      const right = new THREE.Vector3().lerpVectors(worldCorners[1], worldCorners[2], t);

      for (let x = 0; x < segmentsX; x++) {
        const s = x / (segmentsX - 1);
        const posWorld = new THREE.Vector3().lerpVectors(left, right, s);

        // Преобразуем в локальные координаты
        const localPos = posWorld.clone().applyMatrix4(inverseMatrix);

        // Используем оригинальные локальные координаты как базу
        const originalLocalPos = new THREE.Vector3(
          originalCorners[0].x + (originalCorners[1].x - originalCorners[0].x) * s,
          originalCorners[0].y + (originalCorners[3].y - originalCorners[0].y) * t,
          0
        );

        // Смешиваем оригинальную и новую позиции
        const finalLocalPos = new THREE.Vector3(
          localPos.x,
          localPos.y,
          0
        );

        posAttr.setXYZ(y * segmentsX + x, finalLocalPos.x, finalLocalPos.y, finalLocalPos.z);
      }
    }

    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  public setTool(tool: 'move' | 'scale' | 'rotate' | 'distort', checkCurrentTool = true): void {
    if (checkCurrentTool && this.tool === tool) {
      return;
    }

    this.tool = tool;

    if (this.selectedMesh) {
      switch (tool) {
        case 'scale':
          this.clearDistortHandles();
          this.clearRotateHandles(this.selectedMesh);
          this.initResizeHandles(this.selectedMesh);
          break;

        case 'rotate':
          this.clearResizeHandles();
          this.clearDistortHandles();
          this.initRotateHandles(this.selectedMesh);
          break;

        case 'distort':
          this.clearResizeHandles();
          this.clearRotateHandles(this.selectedMesh);
          this.transformControls.detach();
          this.initDistortHandles(this.selectedMesh);
          break;

        default:
          this.clearDistortHandles();
          this.clearRotateHandles(this.selectedMesh);
          this.clearResizeHandles();
          this.initTransform(this.selectedMesh);
      }

      // if (tool === 'scale') {
      //   this.initResizeHandles(this.selectedMesh);
      //   this.transformControls.detach();
      //   this.clearDistortHandles();
      // } else {
      //   this.resizeControls.setTarget(null);  // <--- Снимаем ручки
      //   if (tool === 'distort') {
      //     this.initDistortHandles(this.selectedMesh);
      //   } else {
      //     this.initTransform(this.selectedMesh);
      //   }
      // }
    } else {
      this.clearResizeHandles();
      this.clearDistortHandles();
      this.clearRotateHandles(this.selectedMesh);
      this.transformControls.detach();
    }

    this.render();
  }

  public flipSelected(axis: 'x' | 'y'): void {
    if (!this.selectedMesh) {
      return
    };

    // 1) Берём глобальный bbox и его центр
    const box = new THREE.Box3().setFromObject(this.selectedMesh);
    const c = box.getCenter(new THREE.Vector3());

    // 2) Строим матрицу отражения относительно центра bbox
    const t1 = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
    const s = new THREE.Matrix4().makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, 1);
    const t2 = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z);
    const reflect = new THREE.Matrix4().multiplyMatrices(t2, s).multiply(t1);

    // 3) Применяем к глобальной матрице меша
    const world = this.selectedMesh.matrixWorld.clone();
    const newWorld = new THREE.Matrix4().multiplyMatrices(reflect, world);

    // 4) Переводим в локальные координаты относительно родителя
    const parentInv = new THREE.Matrix4();
    if (this.selectedMesh.parent) {
      parentInv.copy(this.selectedMesh.parent.matrixWorld).invert();
    } else {
      parentInv.identity();
    }
    const newLocal = new THREE.Matrix4().multiplyMatrices(parentInv, newWorld);

    // 5) Декомпозиция -> position / quaternion / scale
    newLocal.decompose(
      this.selectedMesh.position,
      this.selectedMesh.quaternion,
      this.selectedMesh.scale,
    );

    // пересоздаем активный инструмент
    if (this.tool) {
      this.setTool(this.tool, false);
    } else {
      this.render();
    }
  }

  public deleteSelected(): void {
    if (!this.selectedMesh) return;

    this.clearTransform();
    this.scene.remove(this.selectedMesh);
    const index = this.meshes.indexOf(this.selectedMesh);
    if (index >= 0) this.meshes.splice(index, 1);

    this.selectedMesh = null;

    this.render();
  }

  public moveLayerUp(): void {
    if (!this.selectedMesh) {
      return;
    }

    const index = this.meshes.indexOf(this.selectedMesh);

    if (index < this.meshes.length - 1) {
      this.swapLayers(index, index + 1);
      this.render();
    }
  }

  public moveLayerDown(): void {
    if (!this.selectedMesh) {
      return;
    }

    const index = this.meshes.indexOf(this.selectedMesh);

    if (index > 0) {
      this.swapLayers(index, index - 1);
      this.render();
    }
  }

  private swapLayers(i1: number, i2: number): void {
    const m1 = this.meshes[i1];
    const m2 = this.meshes[i2];

    const tempZ = m1.position.z;
    m1.position.z = m2.position.z;
    m2.position.z = tempZ;

    this.meshes[i1] = m2;
    this.meshes[i2] = m1;
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);

    this.renderer.domElement.style.width = '100vw';
    this.renderer.domElement.style.height = '100vh';

    this.render();
  }

  private updateCamera(w: number, h: number): void {
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  private dispose(): void {
    this.removeInteraction();

    // Убираем все слушатели transformControls перед dispose
    this.transformControls.removeEventListener('dragging-changed', this.onDraggingChanged);
    this.transformControls.removeEventListener('objectChange', this.onObjectChange);

    this.transformControls.dispose();

    this.meshes.forEach(m => {
      m.geometry.dispose();
      (<THREE.Material>m.material).dispose();
      this.scene.remove(m);
    });

    this.meshes = [];

    this.clearDistortHandles();

    if (this.renderer) {
      this.renderer.dispose();
      this.canvasWrapper.nativeElement.removeChild(this.renderer.domElement);
    }
  }
}

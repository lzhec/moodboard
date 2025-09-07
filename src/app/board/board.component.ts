import {
  Component, ElementRef, ViewChild, AfterViewInit, OnDestroy,
  ChangeDetectionStrategy
} from '@angular/core';

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ResizeBoxControls } from './controls/controls';
import { fromEvent, map, Observable, of, switchMap, take, takeUntil, zip } from 'rxjs';

type Tool = 'move' | 'scale' | 'rotate' | 'distort';

interface CustomPointerEvent {
  tool: Tool;
  activeIndex?: number;
  anchorIndex?: number;
  anchor?: THREE.Vector3;
  center?: THREE.Vector3;
}

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
  public tool: Tool = 'move';

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
  private rotateStartRotation = 0;
  private rotateLines: THREE.LineLoop[] = [];
  private rotateStartRotationZ = 0;

  private resizeTimeout: ReturnType<typeof setTimeout>;
  private isPanning = false;
  private panStart = new THREE.Vector2();
  private panEnd = new THREE.Vector2();
  private panDelta = new THREE.Vector2();
  private isDraggingImage = false;
  private dragStartMouse = new THREE.Vector2();
  private dragStartPos = new THREE.Vector3();
  private pivot: THREE.Object3D;

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
    const dom = this.renderer.domElement;

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    dom.removeEventListener('mousedown', this.onMouseDown);
    dom.removeEventListener('wheel', this.onWheel);
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

    const pointerDown$ = fromEvent<PointerEvent>(dom, 'pointerdown');
    const pointerMove$ = fromEvent<PointerEvent>(window, 'pointermove');
    const pointerUp$ = fromEvent<PointerEvent>(window, 'pointerup');

    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    dom.addEventListener('mousedown', this.onMouseDown);

    pointerDown$
      .pipe(
        switchMap((event: PointerEvent) => this.onPointerDown(event).pipe(
          switchMap((someData: any) => {
            return pointerMove$.pipe(
              switchMap((event) => this.onPointerMove(event, someData)),
              takeUntil(pointerUp$));
          })
        )),
        takeUntil(fromEvent(dom, 'destroy')),
      )
      .subscribe();

    pointerUp$
      .pipe(
        takeUntil(fromEvent(dom, 'destroy')),
        switchMap((event: PointerEvent) => this.onPointerUp(event)),
      )
      .subscribe();

  }

  private removeInteraction(): void {
    const dom = this.renderer.domElement;

    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    dom.removeEventListener('mousedown', this.onMouseDown);
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

  private onPointerDown(event: PointerEvent): Observable<CustomPointerEvent> {
    this.updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // 1. Проверяем, попадает ли клик в ручки ресайза
    if (this.tool === 'scale' && this.selectedMesh) {
      return this.getScaleData(event);
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

        return of(null);
      }
    }

    // 3. Проверяем, попадает ли клик в ротейт-ручку
    if (this.tool === 'rotate' && this.selectedMesh && this.rotateHandle) {
      const rotateIntersects = this.raycaster.intersectObject(this.rotateHandle);

      if (rotateIntersects.length > 0) {
        this.isRotating = true;

        // Создаём pivot и помещаем в него mesh
        const center = this.getBoundingRectCenter(this.selectedMesh);
        this.pivot = new THREE.Object3D();
        this.scene.add(this.pivot);
        this.pivot.position.copy(center);

        // Сохраняем мировой центр mesh до перемещения
        const worldPos = this.selectedMesh.getWorldPosition(new THREE.Vector3());
        this.pivot.add(this.selectedMesh);
        // После добавления в pivot позиция mesh должна быть локальной
        this.selectedMesh.position.copy(this.selectedMesh.position.clone().sub(center));

        const rectDOM = this.renderer.domElement.getBoundingClientRect();
        const mouseX = event.clientX - rectDOM.left;
        const mouseY = event.clientY - rectDOM.top;

        const centerScreen = center.clone().project(this.camera);
        const cx = (centerScreen.x * 0.5 + 0.5) * rectDOM.width;
        const cy = (-centerScreen.y * 0.5 + 0.5) * rectDOM.height;

        this.rotateStartAngle = Math.atan2(mouseY - cy, mouseX - cx);
        this.rotateStartRotationZ = this.pivot.rotation.z;

        event.preventDefault();
        return of({ tool: 'rotate', center: center });
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

        return of(null); // Кликнули по выбранному слою — ничего менять не нужно
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

    return of(null);
  }

  private onPointerMove(event: PointerEvent, data: CustomPointerEvent): Observable<any> {
    // Логика ресайза
    if (this.tool === 'scale' && this.resizingCorner && this.selectedMesh) {
      return this.scaleToolHandler(event, data);
    }

    // Проверяем, что мы в режиме поворота и идет процесс вращения
    if (this.tool === 'rotate' && this.isRotating && this.selectedMesh) {
      this.rotateToolHandler(event, data);
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
      if (!this.raycaster.ray.intersectPlane(plane, intersectPoint)) return of(null);

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
      return of(null);
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
    }

    return of(null);
  }

  private onPointerUp(event: PointerEvent): Observable<void> {
    if (event.button === 0) {
      if (this.isRotating) {
        this.exitRotateMode();
      }

      this.isDraggingImage = false;
      this.isRotating = false;
      this.draggingCorner = null;
      this.resizingCorner = null;
    }

    return of(null);
  }

  private updateMouse(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private exitRotateMode(): void {
    if (this.pivot && this.selectedMesh) {
      // Обновляем мировую матрицу
      this.pivot.updateMatrixWorld(true);

      // Применяем поворот pivot к мешу
      this.selectedMesh.applyMatrix4(this.pivot.matrix);

      // Сбрасываем pivot
      this.pivot.rotation.set(0, 0, 0);
      this.pivot.position.set(0, 0, 0);
      this.pivot.scale.set(1, 1, 1);

      // Возвращаем меш обратно в сцену
      this.scene.add(this.selectedMesh);

      // Убираем pivot
      this.scene.remove(this.pivot);
      this.pivot = null;
    }

    this.isRotating = false;
    this.rotateStartAngle = 0;
    this.rotateStartRotationZ = 0;

    if (this.selectedMesh) {
      this.updateRotateHandle(this.selectedMesh);
    }

    this.render();
  }

  private getScaleData(event: PointerEvent): Observable<CustomPointerEvent> {
    const resizeIntersects = this.raycaster.intersectObjects(this.resizeSpheres, false);

    if (resizeIntersects.length <= 0) {
      return of(null);
    }

    this.resizingCorner = <THREE.Mesh>resizeIntersects[0].object;

    // Запоминаем начальные параметры с учётом текущего scale
    const geo = <THREE.PlaneGeometry>this.selectedMesh.geometry;
    const originalWidth = geo.parameters.width;
    const originalHeight = geo.parameters.height;

    this.resizeStartSize.set(originalWidth * this.selectedMesh.scale.x, originalHeight * this.selectedMesh.scale.y);
    this.resizeStartPos.copy(this.selectedMesh.position);
    this.resizeStartMouse.set(event.clientX, event.clientY);

    // Якорь — противолежащий угол
    const activeIndex = this.resizeSpheres.indexOf(this.resizingCorner);
    const anchorIndex = (activeIndex + 2) % 4;

    // Получаем углы рамки по вершинам (getBoundingRectFromGeometry возвращает мировые координаты,
    // т.к. внутри он делает mesh.localToWorld(vertex))
    this.selectedMesh.updateMatrixWorld(true);

    const rect = this.getBoundingRectFromGeometry(this.selectedMesh);
    const cornersWorld = [
      new THREE.Vector3(rect.maxX, rect.minY, rect.z),
      new THREE.Vector3(rect.minX, rect.minY, rect.z),
      new THREE.Vector3(rect.minX, rect.maxY, rect.z),
      new THREE.Vector3(rect.maxX, rect.maxY, rect.z),
    ];

    // Переводим якорь в ЛОКАЛЬНЫЕ координаты меша
    const anchor = cornersWorld[anchorIndex].clone(); // фиксируем в world

    return of({
      tool: 'scale',
      activeIndex,
      anchorIndex,
      anchor, // Сохраняем локальный якорь
    });
  }

  private scaleToolHandler(event: PointerEvent, data: CustomPointerEvent): Observable<any> {
    if (this.tool === 'scale' && this.resizingCorner && this.selectedMesh) {
      // Текущее смещение курсора относительно старта
      const dx = event.clientX - this.resizeStartMouse.x;
      const dy = event.clientY - this.resizeStartMouse.y;

      // В зависимости от угла выбираем знак масштабирования
      const cornerIndex = this.resizingCorner.userData['cornerIndex'];

      // Переводим движение мыши в изменение размера
      const sx = (cornerIndex === 1 || cornerIndex === 2) ? -1 : 1;
      const sy = (cornerIndex === 2 || cornerIndex === 3) ? -1 : 1;

      // Новый scale = стартовый размер ± дельта
      const geo = <THREE.PlaneGeometry>this.selectedMesh.geometry;

      // Сохраняем пропорции
      const aspect = this.resizeStartSize.x / this.resizeStartSize.y;

      // Делаем масштабирование по X с сохранением пропорций
      let newWidth = this.resizeStartSize.x + dx * sx;
      newWidth = Math.max(newWidth, 1e-3); // защита от переворота
      const newHeight = newWidth / aspect;

      this.selectedMesh.scale.x = newWidth / geo.parameters.width;
      this.selectedMesh.scale.y = newHeight / geo.parameters.height;

      // Фиксируем якорь
      const anchorIndex = data?.anchorIndex ?? ((cornerIndex + 2) % 4);
      const anchorWorld = data?.anchor;

      // Порядок углов тот же, что и при создании ручек:
      // 0 — нижний правый (BR), 1 — нижний левый (BL), 2 — верхний левый (TL), 3 — верхний правый (TR)
      if (data?.anchor) {
        // Пересчитываем текущие углы рамки (они возвращаются в мировых координатах)
        this.selectedMesh.updateMatrixWorld(true);

        // Текущий якорь после скейла в ЛОКАЛЕ
        const rect = this.getBoundingRectFromGeometry(this.selectedMesh);
        const newCornersWorld = [
          new THREE.Vector3(rect.maxX, rect.minY, rect.z),
          new THREE.Vector3(rect.minX, rect.minY, rect.z),
          new THREE.Vector3(rect.minX, rect.maxY, rect.z),
          new THREE.Vector3(rect.maxX, rect.maxY, rect.z),
        ];

        const newAnchorWorld = newCornersWorld[data.anchorIndex].clone();

        // Дельта в мировых координатах: куда сместился угол — исправим её
        const worldDelta = data.anchor.clone().sub(newAnchorWorld); // anchorWorld - newAnchorWorld

        // Перевести дельту в локальную систему родителя (если есть)
        if (this.selectedMesh.parent) {
          const parentInv = new THREE.Matrix4().copy(this.selectedMesh.parent.matrixWorld).invert();
          const localDelta = worldDelta.clone().applyMatrix4(parentInv);

          this.selectedMesh.position.add(localDelta);
        } else {
          // без родителя — просто в world (хотя у тебя всегда есть сцена родитель)
          this.selectedMesh.position.add(worldDelta);
        }
      }

      // Обновляем ручки
      this.clearResizeHandles();
      this.createResizeHandles(this.selectedMesh);

      this.render();
    }

    return of(null);
  }

  private rotateToolHandler(event: PointerEvent, data: CustomPointerEvent): void {
    const rectDOM = this.renderer.domElement.getBoundingClientRect();
    const mouseX = event.clientX - rectDOM.left;
    const mouseY = event.clientY - rectDOM.top;

    const centerScreen = data.center.clone().project(this.camera);
    const cx = (centerScreen.x * 0.5 + 0.5) * rectDOM.width;
    const cy = (-centerScreen.y * 0.5 + 0.5) * rectDOM.height;

    const currentAngle = Math.atan2(mouseY - cy, mouseX - cx);
    let angleDelta = currentAngle - this.rotateStartAngle;

    if (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;
    if (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;

    this.pivot.rotation.z = this.rotateStartRotationZ + angleDelta;

    // Обновляем рамку и ручку
    this.updateRotateHandle(this.selectedMesh);

    this.render();
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

    const rect = this.getBoundingRectFromGeometry(mesh);

    const corners = [
      new THREE.Vector3(rect.maxX, rect.minY, rect.z), // нижний правый
      new THREE.Vector3(rect.minX, rect.minY, rect.z), // нижний левый
      new THREE.Vector3(rect.minX, rect.maxY, rect.z), // верхний левый
      new THREE.Vector3(rect.maxX, rect.maxY, rect.z)  // верхний правый
    ];

    // Рисуем бордер прямоугольника
    const borderMaterial = new THREE.LineBasicMaterial({
      color: 0x00aaff,
      linewidth: 2,
    });

    const borderGeometry = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);
    const borderLine = new THREE.LineLoop(borderGeometry, borderMaterial);

    this.scene.add(borderLine);
    this.borderLines.push(borderLine);

    // Ручки по углам
    for (let i = 0; i < 4; i++) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(8, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0x00aaff })
      );
      sphere.position.copy(corners[i]);
      sphere.userData['cornerIndex'] = i;

      this.scene.add(sphere);
      this.resizeSpheres.push(sphere);
    }

    this.render();
  }

  private createRotateHandle(mesh: THREE.Mesh): void {
    // Удаляем существующие бордеры и ручку
    this.clearRotateHandles(mesh);

    // Получаем bounding rect по вершинам (учитываем дисторт)
    const rect = this.getBoundingRectFromGeometry(mesh);

    // Прямоугольная рамка
    const corners = [
      new THREE.Vector3(rect.maxX, rect.minY, rect.z), // BR
      new THREE.Vector3(rect.minX, rect.minY, rect.z), // BL
      new THREE.Vector3(rect.minX, rect.maxY, rect.z), // TL
      new THREE.Vector3(rect.maxX, rect.maxY, rect.z), // TR
    ];

    const borderMaterial = new THREE.LineBasicMaterial({
      color: 0xff0000,
      linewidth: 2
    });

    const borderGeometry = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);

    const borderLine = new THREE.LineLoop(borderGeometry, borderMaterial);
    borderLine.name = 'rotate-border';
    borderLine.renderOrder = 1000;
    this.scene.add(borderLine);
    this.rotateLines.push(borderLine);

    // Ручка по центру верхней грани
    const handleGeometry = new THREE.CircleGeometry(15, 32);
    const handleMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 0.5,
      depthTest: false
    });

    this.rotateHandle = new THREE.Mesh(handleGeometry, handleMaterial);
    this.rotateHandle.name = 'rotate-handle';
    this.rotateHandle.renderOrder = 1000;

    const centerTop = new THREE.Vector3((rect.minX + rect.maxX) / 2, rect.maxY + 30, rect.z);
    this.rotateHandle.position.copy(centerTop);

    this.scene.add(this.rotateHandle);
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

  private updateRotateHandle(mesh: THREE.Mesh): void {
    if (!mesh) return;

    const rect = this.getBoundingRectFromGeometry(mesh);

    // рамка
    const rectCorners = [
      new THREE.Vector3(rect.maxX, rect.minY, rect.z),
      new THREE.Vector3(rect.minX, rect.minY, rect.z),
      new THREE.Vector3(rect.minX, rect.maxY, rect.z),
      new THREE.Vector3(rect.maxX, rect.maxY, rect.z)
    ];

    if (this.rotateLines.length > 0) {
      const borderGeometry = new THREE.BufferGeometry().setFromPoints([
        ...rectCorners, rectCorners[0]
      ]);
      (this.rotateLines[0] as THREE.LineLoop).geometry.dispose();
      (this.rotateLines[0] as THREE.LineLoop).geometry = borderGeometry;
    }

    // ручка
    if (this.rotateHandle) {
      const centerTop = new THREE.Vector3((rect.minX + rect.maxX) / 2, rect.maxY + 30, rect.z);
      this.rotateHandle.position.copy(centerTop);
    }
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

  private clearDistortHandles(): void {
    this.cornerSpheres.forEach(s => {
      this.scene.remove(s);
      s.geometry.dispose();
      (<THREE.Material>s.material).dispose();
    });
    this.cornerSpheres = [];
    this.render();
  }

  private getBoundingRectFromGeometry(mesh: THREE.Mesh): { minX: number, maxX: number, minY: number, maxY: number, z: number } {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.attributes['position'] as THREE.BufferAttribute;

    const vertex = new THREE.Vector3();
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    let z = 0;

    for (let i = 0; i < posAttr.count; i++) {
      vertex.fromBufferAttribute(posAttr, i);
      mesh.localToWorld(vertex); // перевод в мировые координаты

      if (vertex.x < minX) minX = vertex.x;
      if (vertex.x > maxX) maxX = vertex.x;
      if (vertex.y < minY) minY = vertex.y;
      if (vertex.y > maxY) maxY = vertex.y;

      z = vertex.z; // всё в одной плоскости
    }

    return { minX, maxX, minY, maxY, z };
  }

  private getBoundingRectCenter(mesh: THREE.Mesh): THREE.Vector3 {
    const rect = this.getBoundingRectFromGeometry(mesh);
    return new THREE.Vector3(
      (rect.minX + rect.maxX) / 2,
      (rect.minY + rect.maxY) / 2,
      rect.z
    );
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

  public setTool(tool: 'move' | 'scale' | 'rotate' | 'distort', checkCurrentTool = true): void {
    if (checkCurrentTool && this.tool === tool) {
      return;
    }

    if (this.tool === 'rotate' && tool !== 'rotate') {
      this.exitRotateMode();
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

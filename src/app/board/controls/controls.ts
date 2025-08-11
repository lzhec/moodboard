import * as THREE from 'three';

export class ResizeBoxControls extends THREE.Group {
  private camera: THREE.Camera;
  private domElement: HTMLElement;
  private target: THREE.Mesh | null = null;

  public handles: THREE.Mesh[] = [];
  private draggingHandle: THREE.Mesh | null = null;
  private dragStartMouse = new THREE.Vector2();
  private dragStartScale = new THREE.Vector3();

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  public onChange: (() => void) | null = null;

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    super();
    this.camera = camera;
    this.domElement = domElement;

    this.createHandles();
    this.initEvents();

    this.visible = false;
  }

  /** Назначить целевой объект или убрать выделение */
  setTarget(object: THREE.Mesh | null) {
    this.target = object;
    this.visible = !!object;
    if (object) {
      this.updateHandlesPosition();
    } else {
      this.draggingHandle = null; // сбрасываем перетаскивание
    }
    if (this.onChange) this.onChange();
  }

  /** Пересчёт позиций ручек */
  public updateHandlesPosition() {
    if (!this.target) return;

    const bbox = new THREE.Box3().setFromObject(this.target);
    const min = bbox.min;
    const max = bbox.max;

    this.handles[0].position.set(min.x, max.y, 0); // верх-лево
    this.handles[1].position.set(max.x, max.y, 0); // верх-право
    this.handles[2].position.set(max.x, min.y, 0); // низ-право
    this.handles[3].position.set(min.x, min.y, 0); // низ-лево
  }

  /** Создание угловых ручек */
  private createHandles() {
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    const material = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    for (let i = 0; i < 4; i++) {
      const handle = new THREE.Mesh(geometry, material.clone());
      handle.name = `handle-${i}`;
      this.handles.push(handle);
      this.add(handle);
    }
  }

  private initEvents() {
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
  }

  /** Начало перетаскивания ручки */
  private onPointerDown = (event: PointerEvent) => {
    if (!this.target) return;

    this.updateMouse(event);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const intersects = this.raycaster.intersectObjects(this.handles, false);
    if (intersects.length > 0) {
      this.draggingHandle = intersects[0].object as THREE.Mesh;
      this.dragStartMouse.set(event.clientX, event.clientY);
      this.dragStartScale.copy(this.target.scale);
      event.preventDefault();
    }
  };

  /** Драг ручки */
  private onPointerMove = (event: PointerEvent) => {
    if (!this.target || !this.draggingHandle) return;

    const dx = event.clientX - this.dragStartMouse.x;
    const dy = event.clientY - this.dragStartMouse.y;

    const scaleFactorX = 1 + dx * 0.01;
    const scaleFactorY = 1 - dy * 0.01;

    const newScaleX = Math.max(0.1, this.dragStartScale.x * scaleFactorX);
    const newScaleY = Math.max(0.1, this.dragStartScale.y * scaleFactorY);

    this.target.scale.set(newScaleX, newScaleY, this.target.scale.z);

    // Обновляем позиции ручек прямо во время движения
    this.updateHandlesPosition();

    // Сообщаем внешнему коду о том, что объект изменился
    if (this.onChange) this.onChange();
  };

  /** Конец драга */
  private onPointerUp = () => {
    this.draggingHandle = null;
  };

  /** Преобразуем координаты мыши в нормализованные */
  private updateMouse(event: PointerEvent) {
    const rect = this.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Очистка событий */
  dispose() {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
  }
}
